/**
 * 0.6.3 V3 — "when did a sync round last actually succeed", for `/status`.
 *
 * Deliberately NOT `sync_cursor.updated_at`: that column only moves when a
 * round writes a cursor, so a daemon doing empty round after empty round
 * looks frozen in the past even though it is perfectly healthy. And
 * deliberately not a field on the status broadcaster either — that instance
 * is evicted on profile switch, which would silently drop the value.
 *
 * Process-local by design: `null` after a restart is the honest answer, since
 * a cloud daemon that just booted has not synced yet.
 *
 * Keyed on `AppContext` in a WeakMap (same idiom as `lastPruneAt` in
 * manual.ts). `AppContext` is mutated in place by a profile switch rather than
 * replaced, so the key survives the swap — `resetSyncSuccess` has to be called
 * explicitly from the switch, next to `resetOutboxPruneThrottle`, or the new
 * account inherits the previous account's success time.
 */

import type { AppContext } from '../context.js';

const lastSuccessAt = new WeakMap<AppContext, number>();

export function recordSyncSuccess(ctx: AppContext, nowMs: number = Date.now()): void {
  lastSuccessAt.set(ctx, nowMs);
}

export function readLastSyncSuccessAt(ctx: AppContext): number | null {
  return lastSuccessAt.get(ctx) ?? null;
}

/** P5-d Phase 14 hook: a switch swapped the db under this ctx. */
export function resetSyncSuccess(ctx: AppContext): void {
  lastSuccessAt.delete(ctx);
}
