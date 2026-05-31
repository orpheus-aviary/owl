/**
 * P5-d Phase 14 — profile-switch gate (design §5.4.2 / D9).
 *
 * An independent ctx-level lock that serialises profile switches and lets
 * `switchProfile` quiesce the daemon during the sub-second db-replace window.
 * Deliberately NOT the `syncCoalescer` (manual.ts), which only serialises
 * sync runs and can't cover business mutations or the scheduler.
 *
 * Three jobs:
 *  - `isSwitching()` — the server hook reads it to reject mutating HTTP with
 *    503 while a switch is in flight.
 *  - `generation()` — a monotonic counter bumped on each switch, so
 *    `ensureBackgroundHandles` can detect that a switch happened across its
 *    `await` and discard a now-stale bridge/scheduler instead of attaching
 *    it (bridge-lifecycle.ts epoch check, design §2 P1/v4).
 *  - in-flight mutation drain — every mutating request that passes the gate
 *    is counted via `trackMutation()`; `runExclusive` waits for the count to
 *    reach 0 before running the switch body, so the swap never closes the
 *    sqlite handle out from under a mutation that's mid-flight.
 *
 * Single-threaded-atomicity note: the server hook checks `isSwitching()` and
 * calls `trackMutation()` synchronously (no await between), so a request can
 * never slip past the gate yet escape the drain count.
 */

export interface SwitchGate {
  /** True while a `runExclusive` body is executing. */
  isSwitching(): boolean;
  /** Monotonic counter, incremented when each `runExclusive` body begins. */
  generation(): number;
  /** Mark a mutating request that passed the gate; returns its release fn. */
  trackMutation(): () => void;
  /**
   * Run `body` exclusively: serialise against other switches, set the
   * switching flag + bump the generation, wait for in-flight mutations to
   * drain, then run. The flag clears even if `body` rejects.
   */
  runExclusive<T>(body: () => Promise<T>): Promise<T>;
}

/**
 * Return `ctx.switchGate`, lazily creating it if absent. cli.ts sets one at
 * boot; this covers the test entry points (buildServer / switchProfile called
 * with a bare ctx) and narrows the optional field to a concrete gate.
 */
export function ensureSwitchGate(ctx: { switchGate?: SwitchGate }): SwitchGate {
  if (!ctx.switchGate) ctx.switchGate = createSwitchGate();
  return ctx.switchGate;
}

export function createSwitchGate(): SwitchGate {
  let switching = false;
  let generation = 0;
  let inflight = 0;
  let drainWaiters: Array<() => void> = [];
  // Serialises concurrent switches; rejections are swallowed so a failed
  // switch doesn't poison the queue for the next one.
  let lock: Promise<unknown> = Promise.resolve();

  function settleDrainIfIdle(): void {
    if (inflight === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  function drainMutations(): Promise<void> {
    if (inflight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainWaiters.push(resolve);
    });
  }

  return {
    isSwitching: () => switching,
    generation: () => generation,
    trackMutation() {
      inflight += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inflight -= 1;
        settleDrainIfIdle();
      };
    },
    runExclusive<T>(body: () => Promise<T>): Promise<T> {
      const run = lock.then(async () => {
        switching = true;
        generation += 1;
        try {
          await drainMutations();
          return await body();
        } finally {
          switching = false;
        }
      });
      lock = run.catch(() => undefined);
      return run;
    },
  };
}
