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

import {
  type RunSyncResult,
  SkybridgeAuthRequiredError,
  type SkybridgeConfig,
  SkybridgeNotConfiguredError,
  SkybridgeServerUrlMissingError,
  clearSkybridgeAuth,
  readSkybridgeConfig,
  runSync,
  skybridgeConfigPath,
  writeSkybridgeConfig,
} from '@owl/core';
import type { AppContext } from '../context.js';
import { ensureBackgroundHandles } from './bridge-lifecycle.js';
import { createCoalescer } from './coalesce.js';
import {
  type RealSkybridgeClient,
  SkybridgeNotInstalledError,
  adaptClient,
  ensureSkybridgeSession,
  invalidateSkybridgeSession,
  loadSkybridgeClient,
} from './session.js';
import { getSyncStatusBroadcaster } from './status-broadcaster.js';

export { SkybridgeNotInstalledError };
export type { RealSkybridgeClient };

// ─── runSync logger shim ──────────────────────────────────────────────
//
// `RunSyncLogger` in core uses a variadic shape `(...a: unknown[]) => void`
// because most engine call sites pass a single templated string. But
// `withRetry` in core/sync/retry.ts (and other future structured-log
// sites) call pino-style `logger.warn({ kind, attempt, ... }, msg)`. A
// naive `a.map(String).join(' ')` adapter stringifies the object arg as
// the literal `[object Object]`, hiding all the retry detail we need
// when debugging. P5-c M6 caught this.
//
// emitSyncLog detects the pino `(obj, msg)` shape and merges the object
// into the structured payload; otherwise it falls back to the legacy
// stringified template path. Exported for direct unit testing.

type PinoLikeWarn = (
  obj: Record<string, unknown>,
  msg?: string,
  ...rest: unknown[]
) => void;

export function emitSyncLog(emit: PinoLikeWarn, args: unknown[]): void {
  if (
    args.length >= 1 &&
    typeof args[0] === 'object' &&
    args[0] !== null &&
    !Array.isArray(args[0]) &&
    !(args[0] instanceof Error)
  ) {
    const firstObj = args[0] as Record<string, unknown>;
    const rest = args.slice(1);
    const msg = rest.length > 0 ? rest.map(String).join(' ') : undefined;
    emit({ kind: 'sync', ...firstObj }, msg);
    return;
  }
  emit({ kind: 'sync' }, args.map(String).join(' '));
}

// ─── Daemon-only error subclasses ─────────────────────────────────────

// SkybridgeNotInstalledError now lives in `./session.js` (re-exported above).

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

// ─── Structural client + adapter + loadSkybridgeClient live in ./session.js.

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

// ─── Module-level coalescing runner ───────────────────────────────────
//
// First caller starts a round. Concurrent callers that arrive WHILE a
// round is in flight share a single follow-up round which fires once the
// inflight one finishes — they cannot reuse the inflight Promise because
// its `SELECT ... WHERE synced_at IS NULL` may have read the outbox
// before their commit landed, silently dropping them from the push.
// (P5-a follow-up F3: PATCH→sync 紧邻偶发 pushedTotal=0.)
//
// The runner closes over `ctx` — `AppContext` is a long-lived singleton
// per daemon process so re-binding on every call would be wasteful.

let currentCtx: AppContext | null = null;
const syncCoalescer = createCoalescer<RunSyncResult>(() => {
  if (!currentCtx) throw new Error('runManualSync called without ctx');
  return doRunManualSync(currentCtx);
});

/**
 * Trigger one manual sync round (CLI / GUI / future background poll).
 * See `createCoalescer` for the dedupe semantics.
 */
export function runManualSync(ctx: AppContext): Promise<RunSyncResult> {
  currentCtx = ctx;
  return syncCoalescer.run();
}

async function doRunManualSync(ctx: AppContext): Promise<RunSyncResult> {
  const cfgPath = skybridgeConfigPath();
  const broadcaster = getSyncStatusBroadcaster(ctx);
  broadcaster.markSyncing();
  try {
    const session = await ensureSkybridgeSession(ctx);
    // P5-c §2.2-bis: if daemon booted with an incomplete toml,
    // bridge-lifecycle skipped the SSE bridge on boot. Now that a
    // session has come up cleanly, kick off background handles in
    // the background — idempotent when already started, never throws.
    // Fire-and-log so a slow ensureSession path inside doesn't push
    // sync round latency up.
    void ensureBackgroundHandles(ctx, ctx.logger).catch((err: unknown) => {
      ctx.logger.warn(
        { kind: 'mid-session-bootstrap', err: errorMessageForLog(err) },
        'ensureBackgroundHandles failed mid-session',
      );
    });
    const result = await runSync({
      db: ctx.db,
      sqlite: ctx.sqlite,
      client: adaptClient(session.realClient),
      workspaceId: session.workspaceId,
      serverUrl: session.serverUrl,
      logger: {
        info: (...a) => emitSyncLog(ctx.logger.info.bind(ctx.logger), a),
        warn: (...a) => emitSyncLog(ctx.logger.warn.bind(ctx.logger), a),
      },
    });
    // P5-b §6.3: success path emits status + reloads the in-memory
    // reminder scheduler from the post-apply reminder_status truth.
    broadcaster.markSuccess({
      pulled_seq: result.cursorAfter,
      pushed_seq: result.serverSeqHigh || undefined,
      last_sync_at: Date.now(),
    });
    if (result.appliedTotal > 0) ctx.scheduler.reload();
    // P5-c §6.19: detection-time poke for the GUI sidebar 红点. Payload-free —
    // subscribers refetch `/conflicts/count` to learn the new value.
    if (result.conflictsRecorded > 0) {
      ctx.eventsBus.emit({ type: 'conflicts:changed' });
    }
    return result;
  } catch (err) {
    // 401 / SkybridgeAuthRequired invalidates the cached session so the
    // next call re-bootstraps against the post-login toml.
    if (isApiError(err) && err.status === 401) {
      invalidateSkybridgeSession(ctx);
    } else if (err instanceof SkybridgeAuthRequiredError) {
      invalidateSkybridgeSession(ctx);
    }
    const translated = translateSkybridgeError(err, cfgPath);
    broadcaster.markError(translated);
    throw translated;
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

function errorMessageForLog(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── Test-only reset (inflight Promise leaks across test cases) ───────

/** @internal */
export function __resetInflightSync(): void {
  syncCoalescer.reset();
}
