/**
 * P5-b §6.3 — sync status broadcaster.
 *
 * Owns the `SyncStatusSnapshot` and emits `sync:status_changed` on the
 * existing OwlEvent bus whenever something flips. Manual sync calls
 * `markSyncing` / `markSuccess` / `markError`; sse-bridge calls
 * `markConnected` / `markOffline`. Initial snapshot pulled from
 * `readSyncStatus` so the first event matches what `/sync/status`
 * returns on cold-start.
 *
 * One broadcaster instance per AppContext (cached on `ctx`) so the
 * dual-profile e2e suite stays isolated and the SSE feed of each
 * profile sees only its own status.
 *
 * ── 0.6.2 W3: `auth_required` is sticky ──────────────────────────────
 *
 * Once we know sync is blocked on authentication, ordinary traffic must not
 * paper over it: an SSE reconnect failing with `markOffline`, or a manual sync
 * calling `markSyncing`, would otherwise erase the one state the GUI acts on.
 * `markAuthRequired` also refuses to *downgrade* the reason — see `AuthReason`
 * for why demoting `token_rejected` to `missing_session` is an infinite loop.
 * Only a real recovery (`markSessionInstalled` / `markSuccess`) clears it.
 */

import type { AppContext } from '../context.js';
import type { AuthReason, SyncState, SyncStatusSnapshot } from '../events/types.js';
import { isAccountProfile } from './account-profile.js';
import { readSyncStatus } from './manual.js';
import { syncRecoveryCapability } from './trigger-gate.js';

export interface SyncStatusBroadcaster {
  snapshot(): SyncStatusSnapshot;
  markSyncing(): void;
  markSuccess(result: { pulled_seq?: number; pushed_seq?: number; last_sync_at?: number }): void;
  markError(err: unknown): void;
  markConnected(): void;
  markOffline(err: unknown): void;
  /** 0.6.2 W3 — sync is blocked until someone re-authenticates. */
  markAuthRequired(reason: AuthReason, message: string): void;
  /** 0.6.2 W3 — a session was just installed; clears `auth_required`. */
  markSessionInstalled(): void;
}

/** Higher wins. A weaker reason may never overwrite a stronger one. */
const REASON_RANK: Record<AuthReason, number> = {
  missing_session: 1,
  token_rejected: 2,
  credentials_missing: 3,
};

const cache = new WeakMap<AppContext, SyncStatusBroadcaster>();

/**
 * Lazy per-AppContext singleton. Two profiles in the same process get
 * independent broadcasters (dual e2e isolation, P5-b §6.3).
 */
export function getSyncStatusBroadcaster(ctx: AppContext): SyncStatusBroadcaster {
  const cached = cache.get(ctx);
  if (cached) return cached;
  const made = createSyncStatusBroadcaster(ctx);
  cache.set(ctx, made);
  return made;
}

/**
 * Drop the cached broadcaster for `ctx`. P5-d Phase 14 — a profile switch
 * mutates `ctx` in place (same object identity), so the WeakMap entry would
 * otherwise survive with a stale `current` snapshot (old server_url /
 * device_id / seq). Evicting forces the next `getSyncStatusBroadcaster` to
 * rebuild `initialSnapshot` off the freshly-swapped db — which also resets
 * the sticky `auth_required` of the profile we just left.
 */
export function evictSyncStatusBroadcaster(ctx: AppContext): void {
  cache.delete(ctx);
}

export function createSyncStatusBroadcaster(ctx: AppContext): SyncStatusBroadcaster {
  let current: SyncStatusSnapshot = initialSnapshot(ctx);

  function emit(next: SyncStatusSnapshot): void {
    current = next;
    ctx.eventsBus.emit({ type: 'sync:status_changed', status: next });
  }

  function recountPending(): number {
    const row = ctx.sqlite
      .prepare('SELECT count(*) AS n FROM sync_changes WHERE synced_at IS NULL')
      .get() as { n: number };
    return row.n;
  }

  /** Every exit from `auth_required` goes through here. */
  function clearAuth(next: Omit<SyncStatusSnapshot, 'auth_reason'>): void {
    emit({ ...next, auth_reason: null });
  }

  return {
    snapshot: () => current,
    markSyncing: () => {
      // A retry with no session can't get anywhere — leaving `auth_required`
      // for「同步中」would strand the UI in a spinner that never resolves.
      if (current.state === 'auth_required' && ctx.skybridgeSession == null) return;
      clearAuth({ ...current, state: 'syncing', last_error: null });
    },
    markSuccess: (result) => {
      clearAuth({
        ...current,
        state: 'idle',
        pending_count: recountPending(),
        pulled_seq: result.pulled_seq ?? current.pulled_seq,
        pushed_seq: result.pushed_seq ?? current.pushed_seq,
        last_sync_at: result.last_sync_at ?? current.last_sync_at,
        last_error: null,
      });
    },
    markError: (err) => {
      // Sticky: record what went wrong, but don't lose the auth reason.
      if (current.state === 'auth_required') {
        emit({ ...current, last_error: errorMessage(err) });
        return;
      }
      emit({ ...current, state: 'error', last_error: errorMessage(err) });
    },
    markConnected: () => {
      // Don't downgrade syncing → idle here; manual sync owns those
      // transitions. Only flip out of offline / error — never out of
      // auth_required, which an open SSE stream says nothing about.
      if (current.state === 'offline' || current.state === 'error') {
        clearAuth({ ...current, state: 'idle', last_error: null });
      }
    },
    markOffline: (err) => {
      if (current.state === 'auth_required') {
        emit({ ...current, last_error: errorMessage(err) });
        return;
      }
      emit({ ...current, state: 'offline', last_error: errorMessage(err) });
    },
    markAuthRequired: (reason, message) => {
      if (current.state === 'auth_required') {
        // Same reason → nothing new to say (dedupe lives here rather than in
        // every caller: the SSE bridge and manual sync both fire on 401).
        if (current.auth_reason === reason) return;
        // Weaker reason → keep the stronger one.
        const rank = current.auth_reason ? REASON_RANK[current.auth_reason] : 0;
        if (REASON_RANK[reason] < rank) return;
      }
      emit({ ...current, state: 'auth_required', auth_reason: reason, last_error: message });
    },
    markSessionInstalled: () => {
      clearAuth({ ...current, state: 'idle', last_error: null });
    },
  };
}

/**
 * The snapshot a freshly-created broadcaster starts from. Evaluated only on
 * creation / after an evict (`getSyncStatusBroadcaster`), NOT continuously —
 * runtime convergence is GUI main's job via `/sync/session` and
 * `/sync/auth-unrecoverable`.
 *
 * The `auth_required` branches exist because a daemon that restarts on its own
 * has no other producer for the signal: with no session installed, the trigger
 * gate silently stops every sync round, so nothing would ever fail loudly
 * enough to report.
 */
function initialSnapshot(ctx: AppContext): SyncStatusSnapshot {
  const base = readSyncStatus(ctx);
  const { state, auth_reason } = initialAuthState(ctx);
  return {
    state,
    server_url: base.server_url,
    device_id: base.device_id,
    workspace_id: base.workspace_id,
    pending_count: base.pending_count,
    pulled_seq: base.pulled_seq,
    pushed_seq: base.pushed_seq,
    last_sync_at: base.last_sync_at,
    last_error: null,
    auth_reason,
  };
}

function initialAuthState(ctx: AppContext): {
  state: SyncState;
  auth_reason: AuthReason | null;
} {
  if (ctx.skybridgeSession != null) return { state: 'idle', auth_reason: null };
  if (!isAccountProfile(ctx)) return { state: 'idle', auth_reason: null };
  const capability = syncRecoveryCapability(ctx);
  if (capability.canReinstall || capability.canRefresh) {
    return { state: 'auth_required', auth_reason: 'missing_session' };
  }
  return { state: 'auth_required', auth_reason: 'credentials_missing' };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Re-exported for callers that want a narrow type.
export type { AuthReason, SyncState, SyncStatusSnapshot };
