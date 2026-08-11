/**
 * Generic two-slot runner coalescer.
 *
 * One round can be in-flight; concurrent callers that arrive during it
 * coalesce into a single follow-up round that fires *after* the in-flight
 * one finishes. Callers waiting on the in-flight round get its result;
 * callers that arrived later get the follow-up's result.
 *
 * Why: the sync engine reads pending outbox rows partway through `runSync`.
 * If a caller's local commit lands while a round is already in flight, the
 * inflight round's outbox read may have happened before the commit; reusing
 * its Promise would tell the caller "your row was not pushed" when it just
 * needed a fresh round. Coalescing into a follow-up guarantees every caller
 * sees a round that began *after* their call returned. (P5-a follow-up F3.)
 */

export interface Coalescer<R, T = never> {
  /**
   * Trigger a round. If none is in flight, starts one immediately.
   * Otherwise schedules / reuses the single follow-up.
   *
   * `trigger` is attributed to whichever slot ends up serving this call, and
   * the whole set is handed to the runner when that slot starts. Coalesced
   * callers must accumulate rather than overwrite: a single "last caller wins"
   * field would mislabel the round whenever SSE / outbox / scheduler fire
   * together, which is exactly when the label matters.
   */
  run(trigger?: T): Promise<R>;
  /**
   * Resolve once the currently in-flight round (and any already-scheduled
   * follow-up) has settled, ignoring its result/rejection. Does NOT start a
   * round. Callers that have first blocked new `run()` calls (the
   * profile-switch gate stops triggers + 503s HTTP) can await this to drain
   * the sync pipeline before closing the db. One pass suffices because no new
   * round can begin while triggers are gated. P5-d Phase 14.
   */
  whenIdle(): Promise<void>;
  /** @internal — test reset to clear both slots between cases. */
  reset(): void;
}

export function createCoalescer<R, T = never>(
  runner: (triggers: T[]) => Promise<R>,
): Coalescer<R, T> {
  let inflight: Promise<R> | null = null;
  let followUp: Promise<R> | null = null;
  // Triggers waiting for the next `start()`. Drained into the round it opens,
  // so a slot never inherits the previous round's labels.
  let pending = new Set<T>();

  function start(): Promise<R> {
    const triggers = [...pending];
    pending = new Set<T>();
    const p = runner(triggers).finally(() => {
      if (inflight === p) inflight = null;
    });
    inflight = p;
    return p;
  }

  return {
    run(trigger?: T) {
      if (trigger !== undefined) pending.add(trigger);
      if (!inflight) return start();
      if (followUp) return followUp;
      // Swallow rejection in the chain join: the follow-up must still run
      // when the inflight rejects — its caller didn't ask for the inflight
      // attempt and shouldn't inherit its failure.
      followUp = inflight
        .catch(() => undefined)
        .then(() => {
          followUp = null;
          return start();
        });
      return followUp;
    },
    whenIdle() {
      const pending = [inflight, followUp].filter((p): p is Promise<R> => p !== null);
      if (pending.length === 0) return Promise.resolve();
      return Promise.allSettled(pending).then(() => undefined);
    },
    reset() {
      inflight = null;
      followUp = null;
      pending = new Set<T>();
    },
  };
}
