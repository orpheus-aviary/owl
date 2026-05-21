/**
 * P5-a Step 7 — daemon-side sync adapter.
 *
 * Bridges `@owl/core` (engine + config) and `@skybridge/client` (real
 * HTTP wire). core never imports skybridge directly; this file does the
 * one variable-specifier `await import('@skybridge/client')` so a clean
 * checkout without skybridge installed still passes `tsc -b`.
 *
 * Flow (design §8.2):
 *  1. read skybridge_config.toml (NotConfigured / ServerUrlMissing /
 *     AuthRequired all bubble up as typed errors)
 *  2. load `@skybridge/client` via dynamic import — variable specifier so
 *     TS does NOT try to resolve the type, falls back to unknown
 *  3. `createSkybridgeClient` with the auth context; if device is missing
 *     call `registerDevice` (lazy first-sync) and re-create the client so
 *     subsequent calls carry `deviceId`; persist back
 *  4. if workspace missing call `ensureWorkspace('owl', 'default')`;
 *     persist back
 *  5. adapt the real `pushChanges` / `pullChanges` shape (returns
 *     `latestSeq` extra) to `SkybridgeClientLike`
 *  6. invoke `runSync`
 *
 * Concurrency: module-level inflight Promise — CLI / GUI / future
 * scheduled triggers all share one round.
 */

import { hostname } from 'node:os';
import {
  type LocalChangeLike,
  type PullResultLike,
  type PushResultLike,
  type RunSyncResult,
  type ServerChangeLike,
  SkybridgeAuthRequiredError,
  type SkybridgeClientLike,
  SkybridgeNotConfiguredError,
  SkybridgeServerUrlMissingError,
  clearSkybridgeAuth,
  readSkybridgeConfig,
  requireAuth,
  runSync,
  skybridgeConfigPath,
  writeSkybridgeConfig,
} from '@owl/core';
import type { SkybridgeConfig } from '@owl/core';
import type { AppContext } from '../context.js';

// ─── App version (sent on registerDevice) ─────────────────────────────

const OWL_APP_VERSION = '0.5.0-dev';

// ─── Daemon-only error subclasses ─────────────────────────────────────

export class SkybridgeNotInstalledError extends Error {
  readonly code = 'SKYBRIDGE_NOT_INSTALLED';
  constructor(readonly cause: unknown) {
    super(
      'skybridge client module not found — run `just skybridge-install` in the owl repo before using sync',
    );
    this.name = 'SkybridgeNotInstalledError';
  }
}

export class SkybridgeServerUnreachableError extends Error {
  readonly code = 'SKYBRIDGE_SERVER_UNREACHABLE';
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SkybridgeServerUnreachableError';
  }
}

export class SkybridgeApiError extends Error {
  readonly code = 'SKYBRIDGE_API_ERROR';
  constructor(
    message: string,
    readonly status: number,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SkybridgeApiError';
  }
}

export class SkybridgeSyncFailedError extends Error {
  readonly code = 'SKYBRIDGE_SYNC_FAILED';
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SkybridgeSyncFailedError';
  }
}

// ─── Structural shape of @skybridge/client (NOT imported as a type) ───
//
// The real `@skybridge/client` package may be absent on a clean checkout,
// so we never name it in an `import` / `import type` statement. The
// shape below is what `runManualSync` actually calls — anything beyond
// these methods is invisible to us. If skybridge changes its public
// surface in a breaking way, this is the single seam to update.

interface SkybridgeAuthContext {
  serverUrl: string;
  token: string;
  user: { id: string; email: string };
}

interface RealSkybridgeClient {
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
}

interface SkybridgeClientModule {
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

async function loadSkybridgeClient(): Promise<SkybridgeClientModule> {
  // Non-literal specifier: TS sees `import(string)` and skips module
  // resolution, so `tsc -b` on a clean checkout (no skybridge installed)
  // still types. Production daemon at first sync attempts the load and
  // surfaces a typed error if the package isn't present.
  const spec: string = '@skybridge/client';
  try {
    const mod = (await import(spec)) as SkybridgeClientModule;
    return mod;
  } catch (err) {
    throw new SkybridgeNotInstalledError(err);
  }
}

// ─── Default device name ──────────────────────────────────────────────

function defaultDeviceName(): string {
  // hostname() can return empty string in containers; fall back to a
  // generic label so registerDevice always sees a non-empty value.
  const host = hostname();
  return host ? `${host} (owl)` : 'owl device';
}

// ─── Adapter: RealSkybridgeClient → SkybridgeClientLike ───────────────

function adaptClient(client: RealSkybridgeClient): SkybridgeClientLike {
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

// ─── Build a fresh client for a config ───────────────────────────────

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

// ─── Error translation from skybridge client / fetch failures ─────────
//
// `@skybridge/client` raises `NetworkError` / `ApiError`-tagged errors;
// since we never `import`-type that module we duck-type on `.name` and
// `.status`. 401 specifically nukes the on-disk [auth] block so the next
// sync surfaces `SKYBRIDGE_AUTH_REQUIRED` instead of replaying a dead
// token.

function isNetworkError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'NetworkError' || name === 'FetchError';
}

function isApiError(err: unknown): err is { status: number; message: string } {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'ApiError' && typeof (err as { status?: unknown }).status === 'number';
}

function translateSkybridgeError(err: unknown, configPath: string): Error {
  // Pass core-typed errors through unchanged
  if (
    err instanceof SkybridgeNotConfiguredError ||
    err instanceof SkybridgeServerUrlMissingError ||
    err instanceof SkybridgeAuthRequiredError ||
    err instanceof SkybridgeNotInstalledError
  ) {
    return err;
  }
  if (isNetworkError(err)) {
    return new SkybridgeServerUnreachableError(
      `skybridge server unreachable: ${(err as Error).message}`,
      err,
    );
  }
  if (isApiError(err)) {
    if (err.status === 401) {
      // Drop dead [auth] block so the next round demands re-login
      try {
        clearSkybridgeAuth(configPath);
      } catch {
        // best-effort; if we can't update the file, the API error still
        // surfaces to the user — they'll re-login manually
      }
      return new SkybridgeAuthRequiredError(
        'skybridge token rejected (401); re-run `owl sync login`',
      );
    }
    return new SkybridgeApiError(
      err.message || `skybridge API error ${err.status}`,
      err.status,
      err,
    );
  }
  if (err instanceof Error) {
    return new SkybridgeSyncFailedError(err.message, err);
  }
  return new SkybridgeSyncFailedError('unknown sync failure', err);
}

// ─── Module-level inflight dedupe ─────────────────────────────────────

let inflightSync: Promise<RunSyncResult> | null = null;

/**
 * Trigger one manual sync round. Concurrent callers (CLI + GUI + future
 * background poll) share the same Promise so we never fire two rounds
 * in parallel on the same daemon.
 */
export function runManualSync(ctx: AppContext): Promise<RunSyncResult> {
  if (inflightSync) return inflightSync;
  inflightSync = doRunManualSync(ctx).finally(() => {
    inflightSync = null;
  });
  return inflightSync;
}

async function doRunManualSync(ctx: AppContext): Promise<RunSyncResult> {
  const cfgPath = skybridgeConfigPath();
  try {
    let config = readSkybridgeConfig(cfgPath); // throws if missing / server.url missing
    requireAuth(config); // throws if [auth] missing

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
      // Re-create client so subsequent calls carry the new deviceId
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
    // At this point `config.workspace` is guaranteed populated (either
    // already on disk or just registered above); the non-null assertion
    // captures that invariant for TS without an extra runtime branch.
    const workspaceId = config.workspace?.id;
    if (!workspaceId)
      throw new SkybridgeSyncFailedError('workspace registration did not yield an id');

    return await runSync({
      sqlite: ctx.sqlite,
      client: adaptClient(client),
      workspaceId,
      serverUrl: config.server.url,
      logger: {
        info: (...a) => ctx.logger.info({ kind: 'sync' }, a.map(String).join(' ')),
        warn: (...a) => ctx.logger.warn({ kind: 'sync' }, a.map(String).join(' ')),
      },
    });
  } catch (err) {
    throw translateSkybridgeError(err, cfgPath);
  }
}

// ─── Login (writes config) ────────────────────────────────────────────

export interface LoginResult {
  server_url: string;
  email: string;
  user_id: string;
}

/**
 * `POST /sync/login` — writes (or replaces) the `[server]` + `[auth]`
 * sections of skybridge_config.toml. Device + workspace are NOT registered
 * here; the first `POST /sync/run` after login does that lazily so the
 * login flow itself is a single round-trip.
 *
 * Accepts an optional `serverUrl` body argument — if absent we reuse the
 * URL already on disk; if neither is present we fail with
 * `SKYBRIDGE_SERVER_URL_MISSING` so the user knows to pass `--server-url`
 * (or pre-write the file).
 */
export async function runManualLogin(
  _ctx: AppContext,
  email: string,
  password: string,
  serverUrl?: string,
): Promise<LoginResult> {
  const cfgPath = skybridgeConfigPath();
  let resolvedUrl = serverUrl;
  if (!resolvedUrl) {
    try {
      const existing = readSkybridgeConfig(cfgPath);
      resolvedUrl = existing.server.url;
    } catch (err) {
      if (
        err instanceof SkybridgeNotConfiguredError ||
        err instanceof SkybridgeServerUrlMissingError
      ) {
        throw new SkybridgeServerUrlMissingError(cfgPath);
      }
      throw err;
    }
  }

  try {
    const sb = await loadSkybridgeClient();
    const result = await sb.login(resolvedUrl, email, password);

    // Preserve device + workspace if already in toml; overwrite server + auth
    let preserved: SkybridgeConfig | null = null;
    try {
      preserved = readSkybridgeConfig(cfgPath);
    } catch {
      // No prior config — first login. We'll write a fresh one.
    }
    const next: SkybridgeConfig = {
      server: { url: result.serverUrl },
      auth: { user_id: result.user.id, token: result.token, email: result.user.email },
      device: preserved?.device,
      workspace: preserved?.workspace,
    };
    writeSkybridgeConfig(next, cfgPath);
    return {
      server_url: result.serverUrl,
      email: result.user.email,
      user_id: result.user.id,
    };
  } catch (err) {
    throw translateSkybridgeError(err, cfgPath);
  }
}

// ─── Status ───────────────────────────────────────────────────────────

export interface SyncStatusResult {
  configured: boolean;
  authenticated: boolean;
  server_url: string | null;
  device_id: string | null;
  workspace_id: string | null;
  pending_count: number;
  pulled_seq: number;
  pushed_seq: number;
  last_sync_at: number | null;
}

interface CursorRow {
  pulled_seq: number;
  pushed_seq: number;
  updated_at: number;
}

export function readSyncStatus(ctx: AppContext): SyncStatusResult {
  const cfgPath = skybridgeConfigPath();
  let config: SkybridgeConfig | null = null;
  try {
    config = readSkybridgeConfig(cfgPath);
  } catch {
    config = null;
  }
  const serverUrl = config?.server.url ?? null;
  const cursorRow = serverUrl
    ? (ctx.sqlite
        .prepare('SELECT pulled_seq, pushed_seq, updated_at FROM sync_cursor WHERE endpoint = ?')
        .get(serverUrl) as CursorRow | undefined)
    : undefined;
  const pendingRow = ctx.sqlite
    .prepare('SELECT count(*) AS n FROM sync_changes WHERE synced_at IS NULL')
    .get() as { n: number };
  return {
    configured: config !== null,
    authenticated: Boolean(config?.auth?.token),
    server_url: serverUrl,
    device_id: config?.device?.id ?? null,
    workspace_id: config?.workspace?.id ?? null,
    pending_count: pendingRow.n,
    pulled_seq: cursorRow?.pulled_seq ?? 0,
    pushed_seq: cursorRow?.pushed_seq ?? 0,
    last_sync_at: cursorRow?.updated_at ?? null,
  };
}

// ─── Status helpers for routing layer ─────────────────────────────────

export function statusForError(err: unknown): number {
  if (err instanceof SkybridgeNotConfiguredError) return 400;
  if (err instanceof SkybridgeServerUrlMissingError) return 400;
  if (err instanceof SkybridgeAuthRequiredError) return 401;
  if (err instanceof SkybridgeNotInstalledError) return 500;
  if (err instanceof SkybridgeServerUnreachableError) return 503;
  if (err instanceof SkybridgeApiError) return err.status;
  return 500;
}

export function codeForError(err: unknown): string {
  if (
    err instanceof SkybridgeNotConfiguredError ||
    err instanceof SkybridgeServerUrlMissingError ||
    err instanceof SkybridgeAuthRequiredError ||
    err instanceof SkybridgeNotInstalledError ||
    err instanceof SkybridgeServerUnreachableError ||
    err instanceof SkybridgeApiError ||
    err instanceof SkybridgeSyncFailedError
  ) {
    return err.code;
  }
  return 'SKYBRIDGE_SYNC_FAILED';
}

export function messageForError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'unknown sync failure';
}

// ─── Test-only reset (inflight Promise leaks across test cases) ───────

/** @internal */
export function __resetInflightSync(): void {
  inflightSync = null;
}
