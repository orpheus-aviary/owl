/**
 * Problem A / Phase 1 — push-on-mutation trigger.
 *
 * Before this, every sync trigger was inbound or periodic: the SSE bridge
 * (someone else pushed), the scheduler (`[sync].interval_min`, default 5min,
 * and operators can disable it outright), and manual `/sync/run`. Nothing fired
 * on a LOCAL write, so an edit sat in `sync_changes` until one of those
 * happened to come around — the "对方改了这边秒到，这边改了很久才出去" asymmetry
 * the user reported.
 *
 * ── Why polling instead of an in-process event from core ──
 *
 * 1. Writers outside this process. `owl --direct` / `--db` opens the same
 *    sqlite file from a separate CLI process, and migrations (0008) INSERT into
 *    `sync_changes` directly. Neither can reach a daemon in-memory emitter. An
 *    event design would additionally need its own boot-time pending scan;
 *    polling is that scan, every tick, for free.
 * 2. Transaction timing. `emitSyncChange`'s contract is "call me inside the
 *    caller's transaction" (core/sync/changes.ts) — broadcasting there fires
 *    before COMMIT, so the event could outlive a rollback, or a debounce could
 *    expire while the row is still invisible to the push query and never fire
 *    again. Polling only ever observes committed state.
 *
 * ── Cost ──
 *
 * One `MAX(local_seq) WHERE synced_at IS NULL` per second. The partial index
 * from 0005 (`idx_sync_changes_pending`) covers it: `local_seq` is the rowid,
 * hence the index's implicit trailing column, so SQLite applies its MIN/MAX
 * optimization and seeks straight to the end. Measured at 0.4µs with 200k
 * pending rows — no new index needed.
 *
 * `count(*)` over the same predicate is NOT in the hot path — it costs 1.8ms
 * at that backlog because it must walk every pending entry. It is read only
 * when a round is actually starting, or when logging a state transition.
 */

import type { Logger } from '@owl/core';
import type { AppContext } from '../context.js';
import { runManualSync } from './manual.js';
import { syncRecoveryCapability, syncTriggerReady } from './trigger-gate.js';

/** Poll cadence. Also the resolution of the debounce below. */
const POLL_MS = 1_000;
/** Fire once the outbox has stopped growing for this long. */
const QUIET_MS = 800;
/** …but never wait longer than this, however fast the user keeps typing. */
const MAX_WAIT_MS = 5_000;
/** Backoff after a failed round, in ms. Last entry repeats. */
const BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000, 16_000, 30_000];
/** ±20% spread so N daemons that failed together don't retry in lockstep. */
const JITTER_RATIO = 0.2;

export interface OutboxWatcherOptions {
  ctx: AppContext;
  logger: Logger;
  /** Override timers for tests (fake clocks). */
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  /** Clock, injectable so tests can drive the debounce deterministically. */
  now?: () => number;
  /** Jitter source; tests pin it to 0.5 (= no offset). */
  random?: () => number;
  /** Override the round action for tests. Production: `runManualSync`. */
  runSync?: (ctx: AppContext) => Promise<unknown>;
}

export interface OutboxWatcherHandle {
  stop(): void;
  /** Run one tick synchronously — test seam; production uses the interval. */
  tickNow(): void;
}

interface PendingProbe {
  hi: number | null;
}

export function createOutboxWatcher(opts: OutboxWatcherOptions): OutboxWatcherHandle {
  const { ctx, logger } = opts;
  const setIntervalFn = opts.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = opts.clearInterval ?? globalThis.clearInterval;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const runSync = opts.runSync ?? runManualSync;

  let stopped = false;
  /** A round started BY THIS WATCHER is in flight. */
  let inflight = false;
  /** Highest pending local_seq seen so far; null when the outbox is clean. */
  let lastHi: number | null = null;
  /** When `lastHi` last changed — the debounce anchor. */
  let hiChangedAt = 0;
  /** When we first saw pending rows after a clean state — the maxWait anchor. */
  let dirtySince = 0;
  /** Consecutive failures; indexes BACKOFF_MS. */
  let failures = 0;
  /** Epoch ms before which we must not start another round. */
  let nextAttemptAt = 0;
  /** Last logged readiness, so we log transitions rather than every tick. */
  let lastReady: boolean | null = null;

  function probePending(): PendingProbe {
    const row = ctx.sqlite
      .prepare('SELECT MAX(local_seq) AS hi FROM sync_changes WHERE synced_at IS NULL')
      .get() as { hi: number | null } | undefined;
    return { hi: row?.hi ?? null };
  }

  function pendingCount(): number {
    const row = ctx.sqlite
      .prepare('SELECT count(*) AS n FROM sync_changes WHERE synced_at IS NULL')
      .get() as { n: number };
    return row.n;
  }

  function logReadiness(ready: boolean): void {
    if (lastReady === ready) return;
    lastReady = ready;
    if (ready) {
      logger.info({ kind: 'outbox-watcher' }, 'sync session available, watcher active');
      return;
    }
    // Not an error: a local-profile daemon legitimately has no session. Log
    // enough to tell "waiting for auto-recovery" from "user must log in".
    const cap = syncRecoveryCapability(ctx);
    logger.info(
      {
        kind: 'outbox-watcher',
        pending_count: pendingCount(),
        can_reinstall: cap.canReinstall,
        can_refresh: cap.canRefresh,
      },
      'no sync session, watcher idle (pending changes held locally)',
    );
  }

  function backoffDelay(): number {
    const base = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
    return Math.round(base * (1 + (random() - 0.5) * 2 * JITTER_RATIO));
  }

  /**
   * Observe the outbox and decide whether a round is due. Returns the highest
   * pending seq when it is time to push, else null. Owns all the debounce
   * bookkeeping so `tick` stays a straight line.
   */
  function dueNow(): number | null {
    const { hi } = probePending();
    const t = now();
    if (hi === null) {
      lastHi = null;
      dirtySince = 0;
      return null;
    }
    if (hi !== lastHi) {
      lastHi = hi;
      hiChangedAt = t;
      if (dirtySince === 0) dirtySince = t;
    }
    if (t < nextAttemptAt) return null;
    const settled = t - hiChangedAt >= QUIET_MS;
    const starved = t - dirtySince >= MAX_WAIT_MS;
    return settled || starved ? hi : null;
  }

  function tick(): void {
    if (stopped) return;
    // A profile switch is mid-flight: `ctx.sqlite` is about to be replaced.
    const gate = ctx.switchGate;
    if (gate?.isSwitching()) return;
    // Our own round is still running. This guard is load-bearing: the sync
    // coalescer queues a follow-up for any caller that arrives during a round
    // AND runs it even when the in-flight round rejected, so polling into it
    // every second would re-run the failed push immediately and step straight
    // over `nextAttemptAt`.
    if (inflight) return;

    const ready = syncTriggerReady(ctx);
    logReadiness(ready);
    if (!ready) return;

    const hi = dueNow();
    if (hi === null) return;

    const epoch = gate?.generation() ?? 0;
    inflight = true;
    logger.debug(
      { kind: 'outbox-watcher', pending_count: pendingCount(), hi },
      'pending outbox, syncing',
    );
    runSync(ctx)
      .then(() => {
        if (stale(epoch)) return;
        failures = 0;
        nextAttemptAt = 0;
        // Re-anchor: whatever is still pending after a successful round is
        // treated as a fresh dirty window rather than an already-expired one.
        lastHi = null;
        dirtySince = 0;
      })
      .catch((err: unknown) => {
        if (stale(epoch)) return;
        failures += 1;
        const delay = backoffDelay();
        nextAttemptAt = now() + delay;
        logger.warn(
          { kind: 'outbox-watcher', err: errorMessage(err), attempt: failures, retry_in_ms: delay },
          'push-on-mutation round failed, backing off',
        );
      })
      .finally(() => {
        inflight = false;
      });
  }

  /**
   * Did the world move on while we were awaiting? Either the watcher was
   * stopped, or a profile switch swapped the db underneath us — in both cases
   * the result describes a context that no longer exists, so it must not
   * advance backoff state or re-anchor the debounce.
   */
  function stale(epoch: number): boolean {
    if (stopped) return true;
    const gate = ctx.switchGate;
    if (!gate) return false;
    return gate.isSwitching() || gate.generation() !== epoch;
  }

  const timer = setIntervalFn(tick, POLL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  logger.info({ kind: 'outbox-watcher', poll_ms: POLL_MS }, 'outbox watcher started');

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
      logger.info({ kind: 'outbox-watcher' }, 'outbox watcher stopped');
    },
    tickNow: tick,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
