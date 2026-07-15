// Profile-switch serialization (Phase 21, layer B). Split out of sync-auth.ts
// into a dependency-free leaf so both the orchestrator (sync-auth.ts) and the
// renewal module (sync-auth-renewal.ts) can share the ONE queue without an
// import cycle.
//
// Every top-level op that swaps the daemon's active profile or (re)installs a
// session — login / logout / quick-switch / delete-local-copy / refresh /
// startup-restore — runs through this queue. Two interleaving would race the
// same toml `active_profile` + /sync/session install; a stray refresh landing
// mid-switch could write the prior account's token into the switched-to profile.
// Each body re-reads config, so serialization alone pins every op to one
// consistent active profile. GUI-internal partner of the cross-process switch
// lockfile (Phase 21c) and the daemon's switch-gate.
//
// NON-REENTRANT: a wrapped function must never call another wrapped function
// (it would deadlock waiting on the queue tail it's holding). Verified: the six
// wrapped entries only call private helpers, never each other.

let switchQueue: Promise<unknown> = Promise.resolve();

export function runSwitchExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = switchQueue.then(() => fn());
  // Swallow rejections on the queue tail so one failed op doesn't poison the
  // next; the caller still observes the real rejection via the returned promise.
  switchQueue = run.catch(() => undefined);
  return run;
}

/** Test-only: reset the serialization queue between cases. */
export function __resetSwitchQueueForTests(): void {
  switchQueue = Promise.resolve();
}
