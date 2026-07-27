import { type SyncStatusSnapshot, getSyncStatus } from '@/lib/api';
import { getPlatform } from '@/platform';
import { create } from 'zustand';
import { currentGen, isStale } from './session-epoch';

/**
 * P5-b §6.3 — renderer-side mirror of daemon's `SyncStatusSnapshot`.
 *
 * Two sources feed this store:
 *   1. one-shot `GET /sync/status` on mount (covers the cold-start case
 *      where the daemon has been running before the renderer opened, so
 *      no `sync:status_changed` SSE event has fired yet). Since 0.6.2 the
 *      GET carries the live `state` / `auth_reason` / `last_error` overlay
 *      too — a cold start is exactly when「需登录」matters most, and the
 *      daemon isn't running any rounds that could fail into an SSE event.
 *   2. SSE `sync:status_changed` events from the existing `/events`
 *      channel (see `events-subscriber-core.ts`)
 *
 * 0.6.2 W3 — every write to `snapshot` goes through `commitSnapshot`. Before,
 * three paths wrote independently (SSE `setSnapshot`, the GET's `applyNow`,
 * and the deferred timer), so any check placed in one of them was blind to the
 * other two — and the GET path is the one that carries `auth_required` on a
 * cold start. `commitSnapshot` validates the state/reason invariant and is the
 * single place that asks the host to recover.
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

  /**
   * The only writer of `snapshot`. Rejects malformed frames, then asks the
   * host to recover when we've just ENTERED a recoverable `auth_required`
   * (staying in the same reason must not re-trigger — the host's own backoff
   * owns the retry cadence).
   */
  function commitSnapshot(next: SyncStatusSnapshot): void {
    const hasReason = next.auth_reason != null;
    if ((next.state === 'auth_required') !== hasReason) {
      console.warn('[sync-status] dropping snapshot with inconsistent auth_reason:', next);
      return;
    }
    const previous = get().snapshot;
    set({ snapshot: next });
    if (next.state !== 'auth_required' || next.auth_reason === null) return;
    // Terminal — the credentials are gone, only a human can fix it.
    if (next.auth_reason === 'credentials_missing') return;
    if (previous?.state === 'auth_required' && previous.auth_reason === next.auth_reason) return;
    getPlatform().sync.requestRecovery?.(next.auth_reason);
  }

  function applyNow(snap: SyncStatusSnapshot): void {
    clearPending();
    commitSnapshot(snap);
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
        set({ minDisplayUntilMs: now + SYNC_STATUS_MIN_DISPLAY_MS });
        commitSnapshot(snap);
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
          set({ pendingTimer: null, pendingSnapshot: null });
          commitSnapshot(queued);
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
            // 0.6.2 W3: `state` / `auth_reason` / `last_error` now come from
            // the daemon. The old code faked `state:'idle'` here, which erased
            // exactly the「需登录」a cold-starting renderer needs to see.
            const { configured: _c, authenticated: _a, ...snapshot } = res.data;
            applyNow(snapshot);
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
