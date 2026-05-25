/**
 * P5-b §6.1 — session bootstrap helper.
 *
 * Lifted out of `manual.ts` so both manual sync and the new sse-bridge
 * (§6.2) can share a single registered-device + workspace handle. Without
 * this, sse-bridge would have to repeat the config-read + dynamic import
 * + registerDevice / ensureWorkspace dance and risk drifting from
 * doRunManualSync.
 *
 * AppContext-scoped cache (`ctx.skybridgeSession`) — not module-level —
 * so the dual-profile e2e suite running two owl instances in one process
 * doesn't share session state between them.
 *
 * Session invalidation: 401 / SkybridgeAuthRequired sets
 * `ctx.skybridgeSession = null` (handled by manual.ts), so the next call
 * re-runs ensureSkybridgeSession against the freshly logged-in toml.
 *
 * device_id / workspace_id sticky-write: every successful ensure writes
 * `skybridge_device_id` + `skybridge_workspace_id` into local_metadata
 * (INSERT OR REPLACE), regardless of whether registerDevice / ensureWorkspace
 * actually ran. mutation paths read these for `notes.device_id` /
 * `folders.device_id` columns. P5-b §3.3.
 *
 * Non-destructive backfill: first time we see a real skybridge device id
 * here, sweep notes/folders rows whose device_id is still the local uuid
 * (P5-a vintage) or NULL and stamp them with the real id, then set the
 * `skybridge_backfilled` sentinel so subsequent calls skip the UPDATE.
 */

import { hostname } from 'node:os';
import {
  type LocalChangeLike,
  type PullResultLike,
  type PushResultLike,
  type ServerChangeLike,
  type SkybridgeClientLike,
  type SkybridgeConfig,
  persistSkybridgeIds,
  readSkybridgeConfig,
  requireAuth,
  skybridgeConfigPath,
  writeSkybridgeConfig,
} from '@owl/core';
import type { AppContext } from '../context.js';

const OWL_APP_VERSION = '0.4.2';

// ─── Real-client structural surface (duck-typed from @orpheus-aviary/skybridge-client) ──
//
// The real `@orpheus-aviary/skybridge-client` package may be absent on a clean checkout,
// so we never name it in an `import` / `import type` statement. The
// shape below mirrors what manual.ts / sse-bridge.ts actually call.
// Lifted here so sse-bridge can import the type without circling through
// manual.ts (which would couple the two more than necessary).

export interface SkybridgeAuthContext {
  serverUrl: string;
  token: string;
  user: { id: string; email: string };
}

export interface SseHandlers {
  onChange: (latestSeq: number) => void;
  onOpen?: () => void;
  onError?: (err: Error) => void;
}

export interface RealSkybridgeClient {
  registerDevice(input: {
    name: string;
    appVersion: string;
    clientVersion: string;
  }): Promise<{ id: string; name: string }>;
  ensureWorkspace(tool: string, name: string): Promise<{ id: string; slug?: string }>;
  pushChanges(
    workspaceId: string,
    changes: LocalChangeLike[],
  ): Promise<{
    accepted: { clientChangeId: string; serverSeq: number }[];
    duplicates: { clientChangeId: string; serverSeq: number }[];
    latestSeq: number;
  }>;
  pullChanges(
    workspaceId: string,
    sinceSeq: number,
    limit?: number,
  ): Promise<{ changes: ServerChangeLike[]; hasMore: boolean; latestSeq: number }>;
  subscribeEvents(workspaceId: string, handlers: SseHandlers): () => void;
}

export interface SkybridgeClientModule {
  CLIENT_VERSION: string;
  login(
    serverUrl: string,
    email: string,
    password: string,
  ): Promise<{
    serverUrl: string;
    token: string;
    user: { id: string; email: string };
  }>;
  createSkybridgeClient(opts: {
    authContext: SkybridgeAuthContext;
    deviceId?: string;
  }): RealSkybridgeClient;
}

export class SkybridgeNotInstalledError extends Error {
  readonly code = 'SKYBRIDGE_NOT_INSTALLED';
  constructor(readonly cause: unknown) {
    super(
      'skybridge client module not found — reinstall owl or run `pnpm install` in the dev tree to restore @orpheus-aviary/skybridge-client',
    );
    this.name = 'SkybridgeNotInstalledError';
  }
}

export async function loadSkybridgeClient(): Promise<SkybridgeClientModule> {
  // Non-literal specifier: TS sees `import(string)` and skips module
  // resolution, so `tsc -b` on a clean checkout (no skybridge installed)
  // still types.
  const spec: string = '@orpheus-aviary/skybridge-client';
  try {
    const mod = (await import(spec)) as SkybridgeClientModule;
    return mod;
  } catch (err) {
    throw new SkybridgeNotInstalledError(err);
  }
}

function defaultDeviceName(): string {
  // hostname() can return empty string in containers; fall back to a
  // generic label so registerDevice always sees a non-empty value.
  const host = hostname();
  return host ? `${host} (owl)` : 'owl device';
}

function buildClient(
  sb: SkybridgeClientModule,
  config: SkybridgeConfig & { auth: { user_id: string; token: string; email: string } },
): RealSkybridgeClient {
  return sb.createSkybridgeClient({
    authContext: {
      serverUrl: config.server.url,
      token: config.auth.token,
      user: { id: config.auth.user_id, email: config.auth.email },
    },
    deviceId: config.device?.id,
  });
}

/** Adapter: real client → SkybridgeClientLike for runSync. */
export function adaptClient(client: RealSkybridgeClient): SkybridgeClientLike {
  return {
    async pullChanges(workspaceId, sinceServerSeq): Promise<PullResultLike> {
      const r = await client.pullChanges(workspaceId, sinceServerSeq);
      return { changes: r.changes, hasMore: r.hasMore };
    },
    async pushChanges(workspaceId, changes): Promise<PushResultLike> {
      const r = await client.pushChanges(workspaceId, changes);
      return { accepted: r.accepted, duplicates: r.duplicates };
    },
  };
}

// ─── Session shape + ctx-bound cache ─────────────────────────────────

export interface SkybridgeSession {
  realClient: RealSkybridgeClient;
  module: SkybridgeClientModule;
  config: SkybridgeConfig;
  workspaceId: string;
  deviceId: string;
  serverUrl: string;
}

/**
 * Ensure a usable session for `ctx`. Always re-reads toml + re-bootstraps
 * if the cached session is missing or its config differs from disk (e.g.
 * caller invalidated after a 401 + re-login).
 *
 * Writes `skybridge_device_id` / `skybridge_workspace_id` into
 * local_metadata on every successful call so mutation paths can read
 * the latest id without coordination with this module. The very first
 * time we see a real device id, runs the one-shot non-destructive
 * backfill (UPDATE notes / folders ... WHERE device_id IS NULL OR
 * device_id = local_device_uuid).
 */
export async function ensureSkybridgeSession(ctx: AppContext): Promise<SkybridgeSession> {
  const cached = ctx.skybridgeSession;
  if (cached) return cached;

  const cfgPath = skybridgeConfigPath();
  let config = readSkybridgeConfig(cfgPath);
  requireAuth(config);
  const sb = await loadSkybridgeClient();
  let client = buildClient(
    sb,
    config as SkybridgeConfig & { auth: { user_id: string; token: string; email: string } },
  );

  // Lazy device registration on first sync
  if (!config.device?.id) {
    const device = await client.registerDevice({
      name: defaultDeviceName(),
      appVersion: `owl ${OWL_APP_VERSION}`,
      clientVersion: sb.CLIENT_VERSION,
    });
    config = {
      ...config,
      device: {
        id: device.id,
        name: device.name,
        app_version: `owl ${OWL_APP_VERSION}`,
        client_version: sb.CLIENT_VERSION,
      },
    };
    writeSkybridgeConfig(config, cfgPath);
    client = buildClient(
      sb,
      config as SkybridgeConfig & { auth: { user_id: string; token: string; email: string } },
    );
  }

  // Lazy workspace bootstrap
  if (!config.workspace?.id) {
    const ws = await client.ensureWorkspace('owl', 'default');
    config = {
      ...config,
      workspace: { id: ws.id, slug: ws.slug ?? 'owl/default' },
    };
    writeSkybridgeConfig(config, cfgPath);
  }

  const workspaceId = config.workspace?.id;
  const deviceId = config.device?.id;
  if (!workspaceId || !deviceId) {
    throw new Error('skybridge session bootstrap did not yield workspace + device ids');
  }

  // Sticky-write skybridge ids into local_metadata + run one-shot backfill.
  // Implementation lives in @owl/core to satisfy the P4 Phase 1 invariant
  // (daemon never writes business tables directly).
  persistSkybridgeIds(ctx.sqlite, deviceId, workspaceId);

  const session: SkybridgeSession = {
    realClient: client,
    module: sb,
    config,
    workspaceId,
    deviceId,
    serverUrl: config.server.url,
  };
  ctx.skybridgeSession = session;
  return session;
}

/** Drop the cached session — caller's responsibility on 401 / re-login. */
export function invalidateSkybridgeSession(ctx: AppContext): void {
  ctx.skybridgeSession = null;
}
