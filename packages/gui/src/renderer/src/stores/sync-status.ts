import { type SyncStatusSnapshot, getSyncStatus } from '@/lib/api';
import { create } from 'zustand';
import { currentGen, isStale } from './session-epoch';

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
 * `snapshot === null` means "no snapshot yet" — distinct from "daemon says no
 * sync configured" (a snapshot with `server_url === null`). Whether that null is
 * a cold start or a dead daemon is answered by the separate `probeStatus` field
 * (`pending` vs `unreachable`), so the bar can show「连接中」vs「未连接」instead
 * of silently faking idle.
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

/**
 * Reachability of the local daemon's `/sync/status`, distinct from the sync
 * `state` inside a snapshot:
 *   - `pending`     — no probe has resolved yet (cold start / first paint)
 *   - `ok`          — the daemon answered (GET succeeded or an SSE frame arrived)
 *   - `unreachable` — the daemon itself could not be reached (fetch threw)
 *
 * The status bar shows `unreachable` in preference to any stale snapshot so a
 * daemon that dies mid-session no longer reads as「本地/已同步」(D12).
 */
export type ProbeStatus = 'pending' | 'ok' | 'unreachable';

interface SyncStatusStore {
  snapshot: SyncStatusSnapshot | null;
  /** Reachability of the daemon `/sync/status` probe — drives the down state. */
  probeStatus: ProbeStatus;
  /** Earliest wall-clock ms when a transition away from `syncing` may apply. */
  minDisplayUntilMs: number;
  /** Handle of an in-flight deferred transition; null when no transition is pending. */
  pendingTimer: ReturnType<typeof setTimeout> | null;
  /** Latest non-`syncing` snapshot queued behind `pendingTimer`. */
  pendingSnapshot: SyncStatusSnapshot | null;
  setSnapshot: (snap: SyncStatusSnapshot) => void;
  fetch: () => Promise<void>;
  /** ③: back to the initial per-session shape + drop timers / in-flight probe. */
  reset: () => void;
}

export const useSyncStatus = create<SyncStatusStore>((set, get) => {
  // Single-flight guard, generation-partitioned (③): bootstrap, the SSE
  // `hello`/`onDisconnect` re-probes and manual refreshes can all call `fetch()`
  // at once. Reuse the in-flight probe ONLY when it belongs to the current
  // session — a probe started before a switch must never be handed to the new
  // session's caller (nor allowed to write its result back).
  let probeInflight: { gen: number; promise: Promise<void> } | null = null;

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
    probeStatus: 'pending',
    minDisplayUntilMs: 0,
    pendingTimer: null,
    pendingSnapshot: null,
    setSnapshot: (snap) => {
      // Receiving any snapshot (SSE frame) means the daemon is reachable.
      set({ probeStatus: 'ok' });
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
    fetch: () => {
      const gen = currentGen();
      // Reuse a same-generation in-flight probe so concurrent callers collapse
      // to one GET. A probe from an older session is neither reused nor awaited.
      if (probeInflight && probeInflight.gen === gen) return probeInflight.promise;
      const p = (async () => {
        try {
          const res = await getSyncStatus();
          if (isStale(gen)) return; // session switched mid-probe → drop the result
          // The daemon answered — reachable regardless of whether a snapshot
          // came back (an unconfigured daemon still returns 200).
          if (res.data) {
            const { configured: _c, authenticated: _a, ...rest } = res.data;
            applyNow({ ...rest, state: 'idle', last_error: null });
          }
          set({ probeStatus: 'ok' });
        } catch {
          if (isStale(gen)) return;
          // Daemon itself is unreachable — flag it so the bar shows「未连接」
          // instead of a stale「本地/已同步」. No longer swallowed silently.
          set({ probeStatus: 'unreachable' });
        }
      })();
      probeInflight = { gen, promise: p };
      void p.finally(() => {
        // Clear by identity so a newer probe started after this one settles is
        // never dropped.
        if (probeInflight?.promise === p) probeInflight = null;
      });
      return p;
    },

    reset: () => {
      clearPending();
      probeInflight = null;
      set({ snapshot: null, probeStatus: 'pending', minDisplayUntilMs: 0 });
    },
  };
});
