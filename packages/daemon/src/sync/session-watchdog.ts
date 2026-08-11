/**
 * 0.6.3 V3 — cloud session watchdog.
 *
 * A cloud daemon keeps its skybridge credentials in RAM only (design choice:
 * a server has no keychain, and a refresh token on disk is a worse trade than
 * asking a human to log in again). The consequence is that **every restart
 * silently stops syncing** until somebody opens the web UI and signs in.
 *
 * Nothing surfaced that. Since 0.6.1 the background triggers gate themselves
 * on `syncTriggerReady` and log a single readiness transition, so a daemon
 * with no session is *completely quiet* — the 2026-08-11 review found a cloud
 * server that had been up for days, not syncing, with nothing in the log
 * saying so (and, because of that, still running a version two releases old).
 *
 * This watchdog is the missing signal. It does not fix anything: recovery is
 * still a human logging in. It just makes "not syncing" visible to whoever is
 * watching the log or polling `/status`.
 *
 * ── Two things it must get right ──
 *
 * 1. **Health is `syncTriggerReady`, not "do we hold credentials".**
 *    `trigger-gate.ts` spells out why: after a 401, `invalidateSkybridgeSession`
 *    drops the session but leaves the credentials in place. Treating credentials
 *    as health would report a rejected-token daemon as fine — exactly the state
 *    most worth alerting on.
 *
 * 2. **It belongs to the process, not to the sync background handles.**
 *    `teardownCloudSession` calls `stopBackgroundHandles` and does not restart
 *    it, so a watchdog living in that set would be killed at the precise moment
 *    the session became permanently lost. Boot starts it; graceful shutdown
 *    stops it; session rebind / profile switch / logout / refresh failure all
 *    leave it running.
 */

import type { Logger } from '@owl/core';
import type { AppContext } from '../context.js';
import { syncTriggerReady } from './trigger-gate.js';

/** How often readiness is sampled. */
const POLL_MS = 60_000;
/** Quiet grace period before the first report. */
const FIRST_REPORT_AFTER_MS = 10 * 60_000;
/** Repeat cadence once reported, so a long outage doesn't flood the log. */
const REPEAT_EVERY_MS = 60 * 60_000;

export interface SessionWatchdogDeps {
  pollMs?: number;
  firstReportAfterMs?: number;
  repeatEveryMs?: number;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

export interface SessionWatchdogHandle {
  /** Cancel the timer. Idempotent. Only daemon shutdown should call this. */
  stop(): void;
}

/**
 * Start the watchdog. Returns `null` for a local daemon — a desktop session is
 * owned by GUI main, which has its own recovery path (0.6.2 W3) and a user
 * sitting in front of it.
 */
export function startSessionWatchdog(
  ctx: AppContext,
  logger: Logger,
  deps: SessionWatchdogDeps = {},
): SessionWatchdogHandle | null {
  if (ctx.config.daemon.mode !== 'cloud') return null;

  const pollMs = deps.pollMs ?? POLL_MS;
  const firstReportAfterMs = deps.firstReportAfterMs ?? FIRST_REPORT_AFTER_MS;
  const repeatEveryMs = deps.repeatEveryMs ?? REPEAT_EVERY_MS;
  const now = deps.now ?? Date.now;
  const setI = deps.setInterval ?? globalThis.setInterval;
  const clearI = deps.clearInterval ?? globalThis.clearInterval;

  let stopped = false;
  // Null once a session is up; otherwise when the current gap started.
  let unreadySince: number | null = now();
  let lastReportAt: number | null = null;

  const tick = (): void => {
    if (stopped) return;

    if (syncTriggerReady(ctx)) {
      if (unreadySince !== null) {
        // Only newsworthy if we had actually complained about it.
        if (lastReportAt !== null) {
          logger.info({ kind: 'session-watchdog' }, 'session installed; sync resumed');
        }
        unreadySince = null;
        lastReportAt = null;
      }
      return;
    }

    // Not ready. A gap that starts after a session is lost re-arms the clock,
    // so a second outage gets its own 10-minute grace period.
    if (unreadySince === null) {
      unreadySince = now();
      lastReportAt = null;
      return;
    }

    const elapsed = now() - unreadySince;
    if (elapsed < firstReportAfterMs) return;
    if (lastReportAt !== null && now() - lastReportAt < repeatEveryMs) return;

    lastReportAt = now();
    logger.warn(
      { kind: 'session-watchdog', reason: 'no_session', minutes: Math.floor(elapsed / 60_000) },
      'cloud daemon has no skybridge session; sync is stopped until someone logs in',
    );
  };

  const timer = setI(tick, pollMs);
  // Never hold the event loop open (mirrors parent-probe). Guarded for fake
  // timer doubles that don't implement unref.
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
  logger.info({ kind: 'session-watchdog', pollMs, firstReportAfterMs }, 'started');

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearI(timer);
    },
  };
}
