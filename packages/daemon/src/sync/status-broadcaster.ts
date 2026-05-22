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
 */

import type { AppContext } from '../context.js';
import type { SyncState, SyncStatusSnapshot } from '../events/types.js';
import { readSyncStatus } from './manual.js';

export interface SyncStatusBroadcaster {
  snapshot(): SyncStatusSnapshot;
  markSyncing(): void;
  markSuccess(result: { pulled_seq?: number; pushed_seq?: number; last_sync_at?: number }): void;
  markError(err: unknown): void;
  markConnected(): void;
  markOffline(err: unknown): void;
}

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

  return {
    snapshot: () => current,
    markSyncing: () => {
      emit({ ...current, state: 'syncing', last_error: null });
    },
    markSuccess: (result) => {
      emit({
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
      emit({
        ...current,
        state: 'error',
        last_error: errorMessage(err),
      });
    },
    markConnected: () => {
      // Don't downgrade syncing → idle here; manual sync owns those
      // transitions. Only flip out of offline / error.
      if (current.state === 'offline' || current.state === 'error') {
        emit({ ...current, state: 'idle', last_error: null });
      }
    },
    markOffline: (err) => {
      emit({ ...current, state: 'offline', last_error: errorMessage(err) });
    },
  };
}

function initialSnapshot(ctx: AppContext): SyncStatusSnapshot {
  const base = readSyncStatus(ctx);
  return {
    state: 'idle',
    server_url: base.server_url,
    device_id: base.device_id,
    workspace_id: base.workspace_id,
    pending_count: base.pending_count,
    pulled_seq: base.pulled_seq,
    pushed_seq: base.pushed_seq,
    last_sync_at: base.last_sync_at,
    last_error: null,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// Re-exported for callers that want a narrow type.
export type { SyncState, SyncStatusSnapshot };
