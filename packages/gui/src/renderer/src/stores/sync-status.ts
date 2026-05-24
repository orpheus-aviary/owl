import { type SyncStatusSnapshot, getSyncStatus } from '@/lib/api';
import { create } from 'zustand';

/**
 * P5-b §6.3 — renderer-side mirror of daemon's `SyncStatusSnapshot`.
 *
 * Two sources feed this store:
 *   1. one-shot `GET /sync/status` on mount (covers the cold-start case
 *      where the daemon has been running before the renderer opened, so
 *      no `sync:status_changed` SSE event has fired yet). The GET shape
 *      lacks `state`/`last_error`, so we derive `state='idle'` from a
 *      successful fetch — SSE will overwrite with the live state when
 *      something actually flips.
 *   2. SSE `sync:status_changed` events from the existing `/events`
 *      channel (see `events-subscriber-core.ts`)
 *
 * `null` means "haven't heard from daemon yet" — distinct from "daemon
 * says no sync configured" (which surfaces as a snapshot with the
 * absence of `server_url`/`workspace_id`). The status bar treats `null`
 * like idle to avoid flashing an alarm during the first paint.
 *
 * P5-c G3 — minimum display duration for `syncing`. In-process skybridge
 * during e2e (or any really fast push/pull round) flips `syncing` →
 * `idle` in well under 100 ms; the blue spinner is invisible to the
 * user. The store now records `minDisplayUntilMs` when a `syncing`
 * snapshot arrives, and delays any non-`syncing` transition that lands
 * before that deadline via `setTimeout`. Multiple updates inside the
 * deferred window collapse to the latest one (timer is not re-extended).
 * A `syncing → syncing` update (e.g. consecutive push rounds) clears
 * any pending transition and refreshes the deadline.
 */
export const SYNC_STATUS_MIN_DISPLAY_MS = 400;

interface SyncStatusStore {
  snapshot: SyncStatusSnapshot | null;
  /** Earliest wall-clock ms when a transition away from `syncing` may apply. */
  minDisplayUntilMs: number;
  /** Handle of an in-flight deferred transition; null when no transition is pending. */
  pendingTimer: ReturnType<typeof setTimeout> | null;
  /** Latest non-`syncing` snapshot queued behind `pendingTimer`. */
  pendingSnapshot: SyncStatusSnapshot | null;
  setSnapshot: (snap: SyncStatusSnapshot) => void;
  fetch: () => Promise<void>;
}

export const useSyncStatus = create<SyncStatusStore>((set, get) => {
  function clearPending(): void {
    const { pendingTimer } = get();
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
    }
    set({ pendingTimer: null, pendingSnapshot: null });
  }

  function applyNow(snap: SyncStatusSnapshot): void {
    clearPending();
    set({ snapshot: snap });
  }

  return {
    snapshot: null,
    minDisplayUntilMs: 0,
    pendingTimer: null,
    pendingSnapshot: null,
    setSnapshot: (snap) => {
      const now = Date.now();
      if (snap.state === 'syncing') {
        // Reset the min-display window every time `syncing` reasserts —
        // a follow-up push round after a same-frame settle should still
        // hold the spinner visible long enough to see.
        clearPending();
        set({ snapshot: snap, minDisplayUntilMs: now + SYNC_STATUS_MIN_DISPLAY_MS });
        return;
      }

      const current = get().snapshot;
      const remainingMs = get().minDisplayUntilMs - now;

      // Only defer when we're actively showing `syncing` AND the
      // min-display window hasn't elapsed. Otherwise apply immediately.
      if (current?.state !== 'syncing' || remainingMs <= 0) {
        applyNow(snap);
        return;
      }

      // A pending transition exists → swap in the latest target snapshot
      // without re-extending the timer (P5-c invariant: deadline counts
      // from the most recent `syncing`, not from each follow-up update).
      const existing = get().pendingTimer;
      if (existing !== null) {
        set({ pendingSnapshot: snap });
        return;
      }

      const timer = setTimeout(() => {
        const queued = get().pendingSnapshot;
        if (queued !== null) {
          set({ snapshot: queued, pendingTimer: null, pendingSnapshot: null });
        } else {
          // Defensive: somehow the queued snapshot got cleared without us
          // clearing the timer — drop the timer ref and leave state as is.
          set({ pendingTimer: null });
        }
      }, remainingMs);
      set({ pendingTimer: timer, pendingSnapshot: snap });
    },
    fetch: async () => {
      try {
        const res = await getSyncStatus();
        if (!res.data) return;
        const { configured: _c, authenticated: _a, ...rest } = res.data;
        applyNow({
          ...rest,
          state: 'idle',
          last_error: null,
        });
      } catch {
        // Daemon down / sync not configured — leave snapshot null so the
        // status bar can show its "no daemon" fallback rather than a stale
        // value.
      }
    },
  };
});
