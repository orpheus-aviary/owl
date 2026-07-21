import { create } from 'zustand';

/**
 * ③ 会话隔离原语 — the single source of truth for "which session are we in".
 *
 * Replaces the old `location.reload()` on profile switch. A reload used to
 * guarantee four things atomically: clear every store, discard all in-flight
 * async write-backs, remount the React tree/router, and drop the old SSE
 * connection. Without a reload we reproduce each of those by hand — and the
 * `epoch` counter is what lets in-flight async work tell whether the session it
 * started in is still the current one.
 *
 * Two orthogonal fields:
 *   - `epoch`  — bumped on every session boundary (invalidate / activate). Any
 *                async action captures it at its start and, after every await,
 *                bails if it no longer matches (`isStale`). This is the hard
 *                guard against cross-account data landing in the wrong session.
 *   - `phase`  — `bootstrapping` while `bootstrapSession` is refilling the
 *                stores for a session; `active` once it finishes. `BootstrapOverlay`
 *                reads it to cover the empty-store window (no reload white-flash,
 *                no "empty store" flicker).
 *
 * The store is a real zustand store (not a module counter) so React can
 * subscribe to `epoch` (keying the session root) and `phase` (the overlay),
 * while async guards read it synchronously via `.getState()`.
 *
 * Initial `phase` is `bootstrapping`: the desktop `SessionCoordinator` runs the
 * first `bootstrapSession(0)` on mount and the overlay covers cold start until
 * it calls `endBootstrap(0)`.
 */

export type SessionPhase = 'active' | 'bootstrapping';

interface SessionEpochState {
  epoch: number;
  phase: SessionPhase;
  /**
   * Session went away with nothing to replace it (web logout / 401). Bumps the
   * epoch (invalidating all in-flight work) but leaves `phase` active — no
   * bootstrap follows, the login screen shows instead. Returns the new epoch.
   */
  beginInvalidate: () => number;
  /**
   * A new session is being brought up (desktop profile switch complete / web
   * login). Atomically bumps the epoch AND flips to `bootstrapping` so the
   * overlay covers the reset→refill window. Returns the new epoch to hand to
   * `bootstrapSession`.
   */
  beginBootstrap: () => number;
  /**
   * Finish the bootstrap started at generation `gen`. Only flips to `active`
   * when `gen` is still current — a stale bootstrap (superseded by a newer
   * begin*) must never close a newer session's overlay.
   */
  endBootstrap: (gen: number) => void;
}

export const useSessionEpoch = create<SessionEpochState>((set, get) => ({
  epoch: 0,
  phase: 'bootstrapping',
  beginInvalidate: () => {
    const next = get().epoch + 1;
    set({ epoch: next, phase: 'active' });
    return next;
  },
  beginBootstrap: () => {
    const next = get().epoch + 1;
    set({ epoch: next, phase: 'bootstrapping' });
    return next;
  },
  endBootstrap: (gen) => {
    if (get().epoch === gen) set({ phase: 'active' });
  },
}));

// ─── Async guard helpers ────────────────────────────────────────────────
//
// Read the epoch synchronously (never via a hook) so guards work inside plain
// async store actions and module functions.

/** The current session generation. Capture at an async action's start. */
export const currentGen = (): number => useSessionEpoch.getState().epoch;

/** True once the session has moved on from `gen` — bail before writing back. */
export const isStale = (gen: number): boolean => useSessionEpoch.getState().epoch !== gen;
