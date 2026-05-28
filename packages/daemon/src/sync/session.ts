/**
 * Skybridge session helpers.
 *
 * Two surfaces:
 *   - `ensureSkybridgeSession(ctx)` — returns the cached in-memory
 *     session, or throws `SkybridgeAuthRequiredError`. Phase 10 retired
 *     the lazy toml bootstrap: this function NO LONGER reads toml,
 *     calls registerDevice / ensureWorkspace, or writes the on-disk
 *     config. The only way `ctx.skybridgeSession` becomes non-null is
 *     `installSkybridgeSession` (POST /sync/session from GUI main).
 *
 *   - `installSkybridgeSession(ctx, body)` — Phase 6 path used by
 *     `/sync/session`. Builds the session in memory from explicit HTTP
 *     fields (GUI main already did remote login + registerDevice +
 *     ensureWorkspace) and persists `skybridge_device_id` /
 *     `skybridge_workspace_id` into local_metadata + runs the
 *     non-destructive backfill of notes/folders rows whose device_id
 *     was still the local uuid (P5-a vintage) or NULL.
 *
 * AppContext-scoped cache (`ctx.skybridgeSession`) — not module-level —
 * so the dual-profile e2e suite running two owl instances in one
 * process doesn't share session state between them.
 *
 * Session invalidation: 401 / SkybridgeAuthRequired drops
 * `ctx.skybridgeSession = null` (`doRunManualSync` in manual.ts +
 * `GET /sync/devices` in routes/sync.ts), forcing the next call to
 * surface AUTH_REQUIRED until GUI main re-installs.
 */

import {
  type LocalChangeLike,
  OWL_APP_VERSION,
  type PullResultLike,
  type PushResultLike,
  type ServerChangeLike,
  SkybridgeAuthRequiredError,
  type SkybridgeClientLike,
  type SkybridgeConfig,
  persistSkybridgeIds,
} from '@owl/core';
import type { AppContext } from '../context.js';

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
  /**
   * List devices under the current authenticated user. Used by the
   * Settings → 同步 tab read-only device card (P5-d Phase 10). The SDK
   * returns camelCase `ApiDevice[]`; daemon passes through unchanged
   * and main IPC layer maps to snake_case for renderer consumption.
   */
  listDevices(): Promise<
    {
      id: string;
      name: string;
      platform: string | null;
      appVersion: string | null;
      clientVersion: string | null;
      createdAt: number;
      lastSeenAt: number;
    }[]
  >;
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
 * Return the cached skybridge session, or throw `SkybridgeAuthRequiredError`.
 *
 * P5-d Phase 10 — the daemon's plaintext-bootstrap path is gone. The only
 * way `ctx.skybridgeSession` becomes non-null is `installSkybridgeSession`
 * (POST /sync/session from GUI main, after it has decrypted the toml
 * `encrypted_token` via safeStorage). This function NEVER reads toml,
 * NEVER calls `registerDevice` / `ensureWorkspace`, and NEVER writes
 * the on-disk config — those responsibilities live entirely in GUI main
 * (`sync-auth.ts`).
 *
 * On a fresh daemon process with no session installed, callers see
 * `SKYBRIDGE_AUTH_REQUIRED` and must wait for GUI main to inject the
 * session (Phase 7 keychain restore on startup, or an explicit user
 * login from Settings → 同步 tab).
 *
 * `persistSkybridgeIds` (local_metadata + one-shot backfill) is invoked
 * by `installSkybridgeSession`, not here — see below.
 */
export async function ensureSkybridgeSession(ctx: AppContext): Promise<SkybridgeSession> {
  const cached = ctx.skybridgeSession;
  if (!cached) {
    throw new SkybridgeAuthRequiredError('skybridge session not installed; 请在设置中登录');
  }
  return cached;
}

/** Drop the cached session — caller's responsibility on 401 / re-login. */
export function invalidateSkybridgeSession(ctx: AppContext): void {
  ctx.skybridgeSession = null;
}

// ─── /sync/session install (P5-d Phase 6) ─────────────────────────────

export interface InstallSessionInput {
  token: string;
  user_id: string;
  email: string;
  server_url: string;
  device: {
    id: string;
    name: string;
    app_version?: string;
    client_version?: string;
  };
  workspace: { id: string; slug?: string };
}

/**
 * P5-d Phase 6 — install a fully-resolved skybridge session into `ctx`
 * from an explicit HTTP payload (GUI main has already done login +
 * registerDevice + ensureWorkspace remotely; daemon just plugs the
 * resulting identity into its in-memory cache).
 *
 * Builds a `SkybridgeConfig` in memory only — does NOT write toml. The
 * Phase 7 GUI main path is the sole toml writer; daemon never persists
 * credentials.
 *
 * `persistSkybridgeIds(ctx.sqlite, deviceId, workspaceId)` runs **before**
 * the cache assignment so a partial failure can't leave a session pointing
 * to ids that mutation paths can't read. Positional signature per v3 §3.1.1.
 *
 * Caller (route handler) is responsible for the replace dance:
 *   stopBackgroundHandles(ctx)
 *   ctx.skybridgeSession = null
 *   installSkybridgeSession(ctx, body)
 *   ensureBackgroundHandles(ctx, logger)
 */
export async function installSkybridgeSession(
  ctx: AppContext,
  input: InstallSessionInput,
): Promise<SkybridgeSession> {
  const config: SkybridgeConfig = {
    server: { url: input.server_url },
    auth: { token: input.token, user_id: input.user_id, email: input.email },
    device: {
      id: input.device.id,
      name: input.device.name,
      app_version: input.device.app_version ?? `owl ${OWL_APP_VERSION}`,
      client_version: input.device.client_version ?? '',
    },
    workspace: { id: input.workspace.id, slug: input.workspace.slug ?? 'owl/default' },
  };

  const sb = await loadSkybridgeClient();
  const realClient = buildClient(
    sb,
    config as SkybridgeConfig & { auth: { user_id: string; token: string; email: string } },
  );

  persistSkybridgeIds(ctx.sqlite, input.device.id, input.workspace.id);

  const session: SkybridgeSession = {
    realClient,
    module: sb,
    config,
    workspaceId: input.workspace.id,
    deviceId: input.device.id,
    serverUrl: input.server_url,
  };
  ctx.skybridgeSession = session;
  return session;
}
