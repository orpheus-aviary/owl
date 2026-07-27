/**
 * P5-a Step 7 — daemon-side sync adapter.
 *
 * Bridges `@owl/core` (engine + config) and `@orpheus-aviary/skybridge-client` (real
 * HTTP wire). core never imports skybridge directly; this file does the
 * one variable-specifier `await import('@orpheus-aviary/skybridge-client')` so a clean
 * checkout without skybridge installed still passes `tsc -b`.
 *
 * Flow (design §8.2):
 *  1. read skybridge_config.toml (NotConfigured / ServerUrlMissing /
 *     AuthRequired all bubble up as typed errors)
 *  2. load `@orpheus-aviary/skybridge-client` via dynamic import — variable specifier so
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
  type PruneResult,
  type PruneSkipReason,
  type RunSyncResult,
  SkybridgeAuthRequiredError,
  type SkybridgeConfig,
  SkybridgeNotConfiguredError,
  SkybridgeServerUrlMissingError,
  pruneSyncedChanges,
  readSkybridgeConfig,
  runSync,
  skybridgeConfigPath,
} from '@owl/core';
import { refreshCloudSession } from '../cloud-login.js';
import type { AppContext } from '../context.js';
import { signalAuthRequired } from './auth-signal.js';
import { ensureBackgroundHandles } from './bridge-lifecycle.js';
import { createCoalescer } from './coalesce.js';
import {
  type RealSkybridgeClient,
  SkybridgeNotInstalledError,
  adaptClient,
  ensureSkybridgeSession,
  invalidateSkybridgeSession,
} from './session.js';
import { isApiError, isNetworkError } from './skybridge-errors.js';
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

type PinoLikeWarn = (obj: Record<string, unknown>, msg?: string, ...rest: unknown[]) => void;

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
// The duck-typed predicates live in `./skybridge-errors.js` (Problem A /
// Phase 2B) so `cloud-login.ts` can share them without an import cycle.
// 401 drops the cached session so the next sync surfaces
// `SKYBRIDGE_AUTH_REQUIRED` instead of replaying a dead token.

/**
 * Translate raw SDK / fetch errors into daemon's own error class
 * hierarchy so the `statusForError` / `codeForError` / `messageForError`
 * helpers (which only recognise daemon classes) produce the right HTTP
 * + error_code on the wire.
 *
 * P5-d Phase 10 — no longer takes / uses a `configPath`. The pre-Phase
 * 10 401 branch dropped the dead `[auth]` block from toml via the core
 * helper that core still exports for GUI / tests; that side effect is
 * retired here because the daemon no longer owns toml (GUI main writes
 * encrypted_token via the Phase 7 keychain path). On 401, callers should
 * `invalidateSkybridgeSession(ctx)` so the in-memory session does not
 * keep replaying a dead token. `doRunManualSync` already does this in
 * its catch block; `GET /sync/devices` mirrors it locally.
 */
export function translateSkybridgeError(err: unknown): Error {
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
      return new SkybridgeAuthRequiredError('skybridge token rejected (401); 请在设置中重新登录');
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

/**
 * Resolve once any in-flight sync round (and its already-scheduled follow-up)
 * has settled, without starting a new one. P5-d Phase 14 — `switchProfile`
 * awaits this in its QUIESCE phase, after `stopBackgroundHandles` has cut the
 * sync triggers, so the db swap never closes sqlite under a live push/pull.
 */
export function drainManualSync(): Promise<void> {
  return syncCoalescer.whenIdle();
}

/** One sync round against the currently-installed session. */
async function attemptSyncRound(ctx: AppContext): Promise<RunSyncResult> {
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
  maybePruneOutbox(ctx, session.serverUrl);
  return result;
}

// ─── Outbox retention (0.6.2 W2) ──────────────────────────────────────

/** Minimum gap between two prune attempts on the same database. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// A profile switch mutates the SAME AppContext in place, so this map is really
// process-scoped; `resetOutboxPruneThrottle` is called from the switch teardown
// to restore the intended "once an hour per database" meaning.
const lastPruneAt = new WeakMap<AppContext, number>();

/** Warn once per process per reason — a blocked gate is a standing condition. */
const loggedPruneSkips = new Set<PruneSkipReason>();

/** P5-d Phase 14 hook: a switch swapped the db under this ctx. */
export function resetOutboxPruneThrottle(ctx: AppContext): void {
  lastPruneAt.delete(ctx);
}

/** Injectable for tests; production uses `pruneSyncedChanges` on `ctx.sqlite`. */
export type OutboxPruner = (ctx: AppContext, endpoint: string) => PruneResult;

const defaultPruner: OutboxPruner = (ctx, endpoint) => pruneSyncedChanges(ctx.sqlite, { endpoint });

/**
 * Prune acked outbox rows at most once an hour, after a successful round.
 * Never affects the sync result: a throw is warned and swallowed, and the
 * timestamp advances either way so a failing prune can't run every round.
 */
export function maybePruneOutbox(
  ctx: AppContext,
  endpoint: string,
  prune: OutboxPruner = defaultPruner,
  clock: () => number = Date.now,
): void {
  const now = clock();
  const last = lastPruneAt.get(ctx);
  // No entry = never pruned on this db (boot / post-switch) → run now.
  if (last !== undefined && now - last < PRUNE_INTERVAL_MS) return;
  try {
    const result = prune(ctx, endpoint);
    if (result.pruned) {
      if (result.deleted > 0) {
        ctx.logger.info(
          {
            kind: 'sync-retention',
            deleted: result.deleted,
            cutoff: result.cutoff,
            pulled_seq: result.pulledSeq,
            safe_after: result.safeAfter,
          },
          'pruned acked sync_changes rows',
        );
      }
    } else if (!loggedPruneSkips.has(result.reason)) {
      loggedPruneSkips.add(result.reason);
      ctx.logger.warn(
        { kind: 'sync-retention', reason: result.reason },
        'sync_changes pruning skipped',
      );
    }
  } catch (err) {
    ctx.logger.warn(
      { kind: 'sync-retention', err: errorMessageForLog(err) },
      'sync_changes pruning failed',
    );
  } finally {
    lastPruneAt.set(ctx, now);
  }
}

async function doRunManualSync(ctx: AppContext): Promise<RunSyncResult> {
  const broadcaster = getSyncStatusBroadcaster(ctx);
  broadcaster.markSyncing();
  try {
    let result: RunSyncResult;
    try {
      result = await attemptSyncRound(ctx);
    } catch (err) {
      // Problem A / Phase 2B — a cloud daemon owns its refresh token, so a
      // rejected access token is recoverable in-process. At most one refresh +
      // one retry per round; `attemptSyncRound` is called directly rather than
      // through `runManualSync`, which would re-enter the coalescer.
      if (!(await maybeRecoverCloudSession(ctx, err))) throw err;
      result = await attemptSyncRound(ctx);
    }
    // P5-b §6.3: success path emits status + reloads the in-memory
    // reminder scheduler from the post-apply reminder_status truth.
    broadcaster.markSuccess({
      pulled_seq: result.cursorAfter,
      pushed_seq: result.serverSeqHigh || undefined,
      last_sync_at: Date.now(),
    });
    if (result.appliedTotal > 0) {
      ctx.scheduler.reload();
      // Problem A / Phase 1b — tell the GUI its note/folder data is stale.
      // The renderer's data-bus is otherwise only bumped by local mutations,
      // so a pulled edit sat invisible in sqlite until the user navigated.
      ctx.eventsBus.emit({ type: 'notes:changed' });
    }
    // P5-c §6.19: detection-time poke for the GUI sidebar 红点. Payload-free —
    // subscribers refetch `/conflicts/count` to learn the new value.
    if (result.conflictsRecorded > 0) {
      ctx.eventsBus.emit({ type: 'conflicts:changed' });
    }
    return result;
  } catch (err) {
    // 401 / SkybridgeAuthRequired invalidates the cached session so the
    // next call re-bootstraps against the post-login toml.
    //
    // 0.6.2 W3: the two cases are NOT interchangeable. A 401 means the token
    // we hold was rejected — only a refresh fixes that. A missing session just
    // means nobody installed one yet, and re-installing the stored token is
    // enough. Reporting both as `missing_session` would loop: reinstall the
    // rejected token → 401 → reinstall → …
    const translated = translateSkybridgeError(err);
    if (isApiError(err) && err.status === 401) {
      invalidateSkybridgeSession(ctx);
      signalAuthRequired(ctx, 'token_rejected', messageForError(translated));
    } else if (err instanceof SkybridgeAuthRequiredError) {
      invalidateSkybridgeSession(ctx);
      signalAuthRequired(ctx, 'missing_session', messageForError(translated));
    } else {
      broadcaster.markError(translated);
    }
    throw translated;
  }
}

// ─── Cloud 401 recovery (Problem A / Phase 2B) ────────────────────────

/** Minimum gap between two refresh-on-401 attempts, per daemon process. */
const REFRESH_ON_401_COOLDOWN_MS = 30_000;
const lastRefreshOnUnauthorized = new WeakMap<AppContext, number>();

/** Injectable for tests; production uses `refreshCloudSession`. */
export type CloudRefresher = (ctx: AppContext) => Promise<{ outcome: string }>;

/**
 * Should this failure be retried after refreshing the cloud session?
 *
 * Only a cloud daemon can answer yes: it holds the refresh token in RAM, so a
 * rejected access token is fixable without a human. A desktop daemon never has
 * one — GUI main owns it — so it returns false and the 401 surfaces as
 * `AUTH_REQUIRED` for the Phase 2A recovery path to handle.
 *
 * `refreshCloudSession` is imported statically even though it closes the loop
 * manual → cloud-login → bridge-lifecycle → scheduler → manual. That cycle
 * already existed (manual → bridge-lifecycle → …) and is harmless: every edge
 * is a function called at runtime, never a binding read during module init.
 * A dynamic `import()` here would be tidier on paper but splits the @owl/server
 * tsup bundle into hashed chunks, and that package publishes a single
 * `index.js` — the extra chunks are not in its `files` list, so the published
 * server would crash on first use.
 */
export async function maybeRecoverCloudSession(
  ctx: AppContext,
  err: unknown,
  refresh?: CloudRefresher,
): Promise<boolean> {
  if (ctx.config.daemon.mode !== 'cloud') return false;
  const unauthorized =
    (isApiError(err) && err.status === 401) || err instanceof SkybridgeAuthRequiredError;
  if (!unauthorized) return false;

  const now = Date.now();
  const last = lastRefreshOnUnauthorized.get(ctx) ?? 0;
  if (now - last < REFRESH_ON_401_COOLDOWN_MS) {
    // A dead token would otherwise make every trigger burn a refresh round-trip.
    ctx.logger.info(
      { kind: 'cloud-refresh', since_last_ms: now - last },
      'skipping refresh-on-401 (cooldown)',
    );
    return false;
  }
  lastRefreshOnUnauthorized.set(ctx, now);

  const doRefresh = refresh ?? refreshCloudSession;
  const { outcome } = await doRefresh(ctx);
  ctx.logger.info({ kind: 'cloud-refresh', outcome }, 'refresh-on-401 attempted');
  return outcome === 'refreshed';
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
  // Phase A (A4, §6 / §9 #7) — a cloud daemon never writes skybridge_config.toml
  // (credentials are RAM-only), so the toml path below would always report
  // `configured:false`. Read the binding from the in-RAM CredentialStore /
  // installed session instead; cursor + pending still come from sqlite.
  if (ctx.config.daemon.mode === 'cloud') return readCloudSyncStatus(ctx);

  // Local mode: prefer the live installed session (POST /sync/session) over
  // toml for the binding identity. GUI main writes the `[profiles.<id>]`
  // section + `active_profile` in login Step 7 — AFTER it installs the session
  // in Step 6 — so at install time (and for the status broadcaster's snapshot,
  // which `createSseBridge` seeds synchronously during that install) the toml
  // still resolves to the prior/legacy view and reports null device/workspace.
  // The in-RAM session is the authoritative "bound right now" signal; reading
  // it here keeps `GET /sync/status` and the broadcaster consistent with the
  // account the daemon is actually syncing, instead of flashing「已同步」then
  // reverting to「本地」. Falls back to toml when no session is installed
  // (logged out, or boot before restoreSessionOnStartup).
  const session = ctx.skybridgeSession;
  if (session) {
    const cursor = readCursor(ctx, session.serverUrl);
    return {
      configured: true,
      authenticated: true,
      server_url: session.serverUrl,
      device_id: session.deviceId,
      workspace_id: session.workspaceId,
      pending_count: readPendingCount(ctx),
      pulled_seq: cursor?.pulled_seq ?? 0,
      pushed_seq: cursor?.pushed_seq ?? 0,
      last_sync_at: cursor?.updated_at ?? null,
    };
  }

  const cfgPath = skybridgeConfigPath();
  let config: SkybridgeConfig | null = null;
  try {
    config = readSkybridgeConfig(cfgPath);
  } catch {
    config = null;
  }
  const serverUrl = config?.server.url ?? null;
  const cursor = readCursor(ctx, serverUrl);
  return {
    configured: config !== null,
    // Per-profile configs store credentials as `encrypted_token` (the daemon
    // can't decrypt it); the legacy plaintext `auth.token` is never present, so
    // keying off it read false even when logged in. `assembleConfig` only
    // populates `auth` when *some* credential exists — that's the real signal.
    authenticated: config?.auth != null,
    server_url: serverUrl,
    device_id: config?.device?.id ?? null,
    workspace_id: config?.workspace?.id ?? null,
    pending_count: readPendingCount(ctx),
    pulled_seq: cursor?.pulled_seq ?? 0,
    pushed_seq: cursor?.pushed_seq ?? 0,
    last_sync_at: cursor?.updated_at ?? null,
  };
}

/** Cloud status source: the RAM Layer-1 binding, not toml. */
function readCloudSyncStatus(ctx: AppContext): SyncStatusResult {
  const creds = ctx.credentialStore?.get() ?? null;
  const session = ctx.skybridgeSession;
  const serverUrl = creds?.serverUrl ?? session?.serverUrl ?? null;
  const bound = creds !== null || session !== null;
  const cursor = readCursor(ctx, serverUrl);
  return {
    configured: bound,
    authenticated: bound,
    server_url: serverUrl,
    device_id: creds?.deviceId ?? session?.deviceId ?? null,
    workspace_id: creds?.workspaceId ?? session?.workspaceId ?? null,
    pending_count: readPendingCount(ctx),
    pulled_seq: cursor?.pulled_seq ?? 0,
    pushed_seq: cursor?.pushed_seq ?? 0,
    last_sync_at: cursor?.updated_at ?? null,
  };
}

function readCursor(ctx: AppContext, serverUrl: string | null): CursorRow | undefined {
  if (!serverUrl) return undefined;
  return ctx.sqlite
    .prepare('SELECT pulled_seq, pushed_seq, updated_at FROM sync_cursor WHERE endpoint = ?')
    .get(serverUrl) as CursorRow | undefined;
}

function readPendingCount(ctx: AppContext): number {
  const row = ctx.sqlite
    .prepare('SELECT count(*) AS n FROM sync_changes WHERE synced_at IS NULL')
    .get() as { n: number };
  return row.n;
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
