/**
 * P5-d Phase 6 — parent-process liveness probe.
 *
 * GUI main spawns daemon with `OWL_GUI_PARENT_PID=<gui_pid>` in env. If
 * GUI crashes / quits / is killed without sending SIGTERM (force-quit,
 * power loss followed by reboot mid-shutdown, etc.), daemon would
 * otherwise stay alive holding a session token in memory. The probe
 * polls `process.kill(parentPid, 0)` on a fixed cadence; ESRCH means
 * the parent is gone — daemon tears down the background handles + the
 * cached session and re-enters unauthenticated mode.
 *
 * Why we don't `process.exit(0)`: CLI (and external agents) may still
 * be talking to daemon for non-sync reads even after the GUI is gone.
 * v3 §3.1.1 explicitly preserves the process so those paths keep
 * working. Sync state is the only thing the probe nukes.
 *
 * Why a fixed 10s default: matches design §3.1.1; long enough to keep
 * the wake cost trivial, short enough that a crashed GUI doesn't keep
 * the token reachable for minutes.
 *
 * The interval timer is `unref()`-ed so it never holds the event loop
 * open during shutdown.
 *
 * EPERM is treated as alive — kernel says the parent exists but we lack
 * permission to signal it. Defensive: shouldn't happen for a child of
 * the same user, but if it does, treating it as "gone" would
 * incorrectly tear the session down.
 */

import type { Logger } from '@owl/core';

export interface ParentProbeDeps {
  /** Override probe cadence for tests. Default 10000ms per v3 §3.1.1. */
  intervalMs?: number;
  /** Override timer factory for tests. */
  setInterval?: typeof globalThis.setInterval;
  /** Override timer canceler for tests. */
  clearInterval?: typeof globalThis.clearInterval;
  /** Override the existence check. Signal 0 means "does this pid exist". */
  kill?: (pid: number, signal: 0) => void;
}

export interface ParentProbeHandle {
  /** Cancel the interval timer. Idempotent. */
  stop(): void;
}

interface ErrnoLike {
  code?: string;
}

export function startParentProbe(
  parentPid: number,
  onParentGone: () => void,
  logger: Logger,
  deps: ParentProbeDeps = {},
): ParentProbeHandle {
  const intervalMs = deps.intervalMs ?? 10_000;
  const setI = deps.setInterval ?? globalThis.setInterval;
  const clearI = deps.clearInterval ?? globalThis.clearInterval;
  const killFn =
    deps.kill ??
    ((pid: number, signal: 0): void => {
      process.kill(pid, signal);
    });

  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    try {
      killFn(parentPid, 0);
    } catch (err) {
      const code = (err as ErrnoLike).code;
      if (code === 'ESRCH') {
        logger.warn(
          { kind: 'parent-probe', parentPid },
          'parent process gone; tearing down sync state',
        );
        // Stop ourselves first so onParentGone's side effects don't race
        // a follow-up tick. clearI is harmless on an already-cleared timer.
        stopped = true;
        clearI(timer);
        try {
          onParentGone();
        } catch (cbErr) {
          logger.error({ kind: 'parent-probe', err: String(cbErr) }, 'onParentGone threw');
        }
        return;
      }
      if (code === 'EPERM') {
        // Parent exists but we lack permission to signal — treat as alive.
        return;
      }
      logger.warn(
        { kind: 'parent-probe', parentPid, err: String(err), code },
        'unexpected error from kill(0); treating as alive',
      );
    }
  };

  logger.info({ kind: 'parent-probe', parentPid, intervalMs }, 'started');
  const timer = setI(tick, intervalMs);
  // unref() lets the event loop exit during shutdown without waiting on
  // the next tick. Guard for fake-timer doubles that don't implement it.
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      clearI(timer);
      logger.info({ kind: 'parent-probe' }, 'stopped');
    },
  };
}
