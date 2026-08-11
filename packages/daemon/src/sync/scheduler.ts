import { type Logger, effectiveSyncIntervalMin } from '@owl/core';
import type { AppContext } from '../context.js';
import { runManualSync } from './manual.js';
import { syncRecoveryCapability, syncTriggerReady } from './trigger-gate.js';

export interface SyncSchedulerOptions {
  ctx: AppContext;
  logger: Logger;
  /** Override `setInterval` for testing (fake timers). */
  setInterval?: typeof globalThis.setInterval;
  /** Override `clearInterval` for testing. */
  clearInterval?: typeof globalThis.clearInterval;
  /** Override the per-tick action for testing. Production: `runManualSync`. */
  runSync?: (ctx: AppContext) => Promise<unknown>;
}

export interface SyncSchedulerHandle {
  stop(): void;
}

/**
 * P5-c §2.2 — background sync trigger #2 (timer). SSE bridge handles
 * #1 (server push); §2.2 onError-backoff probe handles #3 (network
 * recovery). All three funnel through `runManualSync` so the P5-a F3
 * coalescer (commit 615e233) keeps overlapping ticks from doubling
 * server load.
 *
 * Disable semantics — `effectiveSyncIntervalMin(ctx.config.sync) === 0`
 * (operator set `<= 0`) → return a noop handle, do not start a timer.
 *
 * Lifecycle — caller (cli.ts post-listen) calls `createSyncScheduler`
 * exactly once per daemon boot. The returned `stop()` is plumbed into
 * the SIGTERM/SIGINT shutdown chain alongside `scheduler.stop()` (the
 * reminder scheduler) and `bridgeHandle.stop()`.
 *
 * Why `setInterval(...).unref()` — without unref the timer keeps the
 * event loop alive after the HTTP server closes, so `daemon stop` would
 * hang for up to one interval. `unref()` lets node exit immediately
 * once everything else is torn down.
 *
 * Why a `running` guard — the previous tick's `runManualSync` returns a
 * Promise; if the interval is shorter than a slow sync round, naive
 * `setInterval` would stack overlapping rounds. The F3 coalescer would
 * still keep server load flat, but we'd waste local CPU on stacked
 * promise chains. Skipping a tick when a round is in flight is cheaper
 * and matches operator expectations ("one tick per interval, at most").
 */
export function createSyncScheduler(opts: SyncSchedulerOptions): SyncSchedulerHandle {
  const { ctx, logger } = opts;
  const minutes = effectiveSyncIntervalMin(ctx.config.sync);
  const setIntervalFn = opts.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = opts.clearInterval ?? globalThis.clearInterval;
  const runSync = opts.runSync ?? ((c: AppContext) => runManualSync(c, 'scheduler'));

  if (minutes === 0) {
    logger.info(
      { interval_min: ctx.config.sync.interval_min },
      'sync scheduler disabled (interval_min <= 0)',
    );
    return { stop: () => {} };
  }

  const intervalMs = minutes * 60_000;
  logger.info({ interval_min: minutes }, 'sync scheduler started');

  let running = false;
  let lastReady: boolean | null = null;
  const timer = setIntervalFn(() => {
    // Problem A / Phase 3 — don't start a round that cannot authenticate.
    // Without this, a daemon on the local profile (or one whose session was
    // dropped by a 401) logs `sync scheduler tick rejected` on every single
    // tick: the 2026-07-23 daemon.log had 163 of them, which buried the real
    // failures. Log the transitions instead, with enough context to tell
    // "waiting for auto-recovery" from "the user must log in again".
    const ready = syncTriggerReady(ctx);
    if (ready !== lastReady) {
      lastReady = ready;
      if (ready) {
        logger.info({ kind: 'sync-scheduler' }, 'sync session available, scheduler active');
      } else {
        const cap = syncRecoveryCapability(ctx);
        logger.info(
          {
            kind: 'sync-scheduler',
            can_reinstall: cap.canReinstall,
            can_refresh: cap.canRefresh,
          },
          'no sync session, scheduler ticks idle',
        );
      }
    }
    if (!ready) return;

    if (running) {
      // Previous round still in flight — skip this tick. The F3 coalescer
      // would absorb the duplicate at the HTTP layer, but skipping here
      // saves the promise-chain churn entirely.
      logger.debug('sync scheduler tick skipped (previous round still running)');
      return;
    }
    running = true;
    runSync(ctx)
      .catch((err: unknown) => {
        logger.warn({ err }, 'sync scheduler tick rejected');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  // Node-only API; not strictly portable but daemon runs on node + Electron
  // (which also exposes it). Browser timers don't have unref but we never
  // execute this code in a browser.
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    stop: () => {
      clearIntervalFn(timer);
      logger.info('sync scheduler stopped');
    },
  };
}
