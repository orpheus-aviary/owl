/**
 * P5-b §6.2 — SSE bridge: server → daemon → manual sync trigger.
 *
 * Subscribes to `/v1/workspaces/:id/events` via the real skybridge
 * client. On a `change` event, calls `runManualSync` (which goes
 * through the F3 coalescer — concurrent events collapse into one
 * follow-up round).
 *
 * Catch-up on (re)connect: `onOpen` runs a `runManualSync` once because
 * server SSE does NOT replay events from before subscription. Without
 * this, a daemon that misses events while offline would only realise
 * after the next user-triggered sync.
 *
 * Reconnect policy (§6.2 / v3 decision): 2/4/8/16/30s + 0-1s jitter,
 * keep retrying forever. "offline" is a status signal (later wired into
 * §6.3 SyncStatusSnapshot), not a give-up state. Truly stopping is left
 * for P5-c.
 *
 * Idle watchdog (2026-06-06, design `docs/plans/2026-06-06-sse-idle-watchdog.md`):
 * the onError path above only recovers from *explicit* disconnects. A
 * half-open / downstream stall — socket alive (no FIN/RST, no read error)
 * but the server silently stopped pushing — fires no callback at all, so
 * the bridge would sit in a zombie "connected" state forever. The server
 * sends a keep-alive `:ok` opener + a `ping` every 25s; the SDK forwards
 * every frame to `onFrame`. We arm a 60s watchdog on `onOpen`, reset it on
 * every frame, and on timeout treat it exactly like an onError (abort the
 * zombie, mark offline, kick the health probe, schedule a reconnect).
 */

import type { Logger } from '@owl/core';
import type { AppContext } from '../context.js';
import { signalAuthRequired } from './auth-signal.js';
import { runManualSync } from './manual.js';
import { type RealSkybridgeClient, invalidateSkybridgeSession } from './session.js';
import { isApiError } from './skybridge-errors.js';
import { getSyncStatusBroadcaster } from './status-broadcaster.js';

export interface SseBridge {
  start(): void;
  stop(): void;
  /**
   * P5-c §3.2 — short-circuit the current backoff window and reconnect now.
   * Called by `health-probe.ts` when /health returns 200 inside the
   * onError → backoff window. No-op when the bridge is not currently
   * waiting on a retry (already connected, never started, or stopped).
   */
  triggerReconnect(): void;
}

export interface SseBridgeHooks {
  /** Called on every onError before scheduleReconnect. P5-c Step 10 wires this to health-probe.start(). */
  onErrorHook?: () => void;
  /** Called on every onOpen before runManualSync. P5-c Step 10 wires this to health-probe.stop(). */
  onOpenHook?: () => void;
}

export interface SseBridgeOptions extends SseBridgeHooks {
  realClient: RealSkybridgeClient;
  workspaceId: string;
  ctx: AppContext;
  logger: Logger;
  /** Override scheduling for tests; default `setTimeout` with `.unref()`. */
  schedule?: (cb: () => void, ms: number) => { cancel: () => void };
  /**
   * Override the idle-watchdog timer for tests; default `setTimeout` with
   * `.unref()`. Separate from `schedule` so tests can drive the watchdog
   * independently of the reconnect backoff.
   */
  armWatchdog?: (cb: () => void, ms: number) => { cancel: () => void };
  /** Idle-watchdog timeout (ms). Default `SSE_IDLE_TIMEOUT_MS` (60s). */
  watchdogMs?: number;
  /** Override jitter so tests can pin the delay. */
  jitter?: (base: number) => number;
}

const BACKOFF_STEPS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

/**
 * Idle-watchdog timeout: 2 server ping intervals (25s each = 50s) + 10s
 * slack. A single dropped ping (jitter / GC / brief loss) must NOT trigger a
 * reconnect; two consecutive misses strongly indicate a dead stream. Worst-
 * case stall detection latency ≈ 60-85s — fine for a background sync daemon,
 * vs. the current behaviour (never recovers). Not user-configurable by design
 * (the threshold is derived from the fixed 25s server ping cadence).
 */
export const SSE_IDLE_TIMEOUT_MS = 60_000;

function defaultSchedule(cb: () => void, ms: number): { cancel: () => void } {
  const t = setTimeout(cb, ms);
  // Don't keep the event loop alive purely for reconnect attempts.
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
}

function defaultJitter(base: number): number {
  return base + Math.floor(Math.random() * 1_000);
}

/** Pick the backoff in ms for the n-th retry (n is 0-indexed). */
export function backoffFor(retryAttempt: number): number {
  // `i` is clamped to a valid index of the non-empty const tuple, so the
  // element is always defined (no fallback / assertion needed).
  const i = Math.min(retryAttempt, BACKOFF_STEPS_MS.length - 1);
  return BACKOFF_STEPS_MS[i];
}

export function createSseBridge(opts: SseBridgeOptions): SseBridge {
  const schedule = opts.schedule ?? defaultSchedule;
  const armWatchdogTimer = opts.armWatchdog ?? defaultSchedule;
  const watchdogMs = opts.watchdogMs ?? SSE_IDLE_TIMEOUT_MS;
  const jitter = opts.jitter ?? defaultJitter;

  let unsubscribe: (() => void) | null = null;
  let retryHandle: { cancel: () => void } | null = null;
  let watchdogHandle: { cancel: () => void } | null = null;
  let retryAttempt = 0;
  let stopped = false;

  const broadcaster = getSyncStatusBroadcaster(opts.ctx);

  /** (Re)arm the idle watchdog: cancel any pending timer, start a fresh one. */
  function armWatchdog(): void {
    if (stopped) return;
    watchdogHandle?.cancel();
    watchdogHandle = armWatchdogTimer(handleIdleTimeout, watchdogMs);
  }

  function clearWatchdog(): void {
    watchdogHandle?.cancel();
    watchdogHandle = null;
  }

  /**
   * The stream went silent past `watchdogMs` with no frame — treat the
   * connection as dead. The SDK can't know (no FIN/RST/read error reached
   * it), so we abort the zombie subscription ourselves (`unsubscribe` →
   * `controller.abort()` → `closed=true`, which makes the zombie's own
   * onError/onOpen/onFrame inert, so there's no double recovery and no need
   * for a generation counter). Then take the same recovery path as onError.
   */
  function handleIdleTimeout(): void {
    if (stopped) return;
    watchdogHandle = null;
    opts.logger.warn(
      { kind: 'sse', watchdogMs },
      'idle watchdog fired: no frame within timeout, reconnecting',
    );
    try {
      unsubscribe?.();
    } catch {
      // best-effort abort of the zombie connection
    }
    unsubscribe = null;
    const err = new Error(`SSE idle timeout: no frame in ${watchdogMs}ms`);
    broadcaster.markOffline(err);
    opts.onErrorHook?.();
    scheduleReconnect();
  }

  function connect(): void {
    if (stopped) return;
    try {
      unsubscribe = opts.realClient.subscribeEvents(opts.workspaceId, {
        onChange: (latestSeq) => {
          opts.logger.info({ kind: 'sse', latestSeq }, 'change event');
          runManualSync(opts.ctx, 'sse').catch((err) => {
            opts.logger.warn(
              { kind: 'sse', err: errorMessage(err) },
              'runManualSync from SSE failed',
            );
          });
        },
        // Any frame (comment / ping / change) proves the stream is alive.
        // change frames reach onChange *after* this, so resetting here
        // covers every downstream signal in one place.
        onFrame: () => {
          armWatchdog();
        },
        onOpen: () => {
          retryAttempt = 0;
          opts.logger.info({ kind: 'sse' }, 'connected');
          broadcaster.markConnected();
          // Start watching for a downstream stall now that we're connected.
          // The server's `:ok` opener arrives immediately and re-arms it.
          armWatchdog();
          // P5-c §3.2: stop the health probe as soon as we're back online.
          // Probe.stop() is idempotent so a probe that already self-stopped
          // after triggering this reconnect is harmless.
          opts.onOpenHook?.();
          // Catch-up: server SSE does not replay history. Pull anything
          // accumulated while we were disconnected.
          runManualSync(opts.ctx, 'sse-reconnect').catch((err) => {
            opts.logger.warn(
              { kind: 'sse', err: errorMessage(err) },
              'reconnect catch-up sync failed',
            );
          });
        },
        onError: (err) => {
          if (handleAuthFailure(err)) return;
          opts.logger.warn({ kind: 'sse', err: errorMessage(err) }, 'SSE error');
          broadcaster.markOffline(err);
          // P5-c §3.2: kick off the health probe so a transient disconnect
          // can recover faster than the SSE retry cap (30s). Bridge still
          // schedules its own reconnect — whichever lands first wins.
          opts.onErrorHook?.();
          scheduleReconnect();
        },
      });
    } catch (err) {
      if (handleAuthFailure(err)) return;
      opts.logger.warn(
        { kind: 'sse', err: errorMessage(err) },
        'subscribeEvents threw; will retry',
      );
      broadcaster.markOffline(err);
      scheduleReconnect();
    }
  }

  /**
   * 0.6.2 W3 — a 401 is not an outage, and retrying it forever is worse than
   * useless. If subscribe itself is rejected, `onOpen` never fires, so its
   * catch-up `runManualSync` never runs either: with `[sync].interval_min <= 0`
   * there would be no REST round at all, and the bridge would sit reconnecting
   * to a dead token while the UI showed「离线」.
   *
   * So: drop the session, put the state machine into `auth_required /
   * token_rejected`, and STOP reconnecting. GUI main's recovery re-installs a
   * session through `/sync/session`, whose `ensureBackgroundHandles` starts a
   * fresh bridge. Returns true when it handled the error.
   */
  function handleAuthFailure(err: unknown): boolean {
    if (!isApiError(err) || err.status !== 401) return false;
    opts.logger.warn({ kind: 'sse', status: 401 }, 'SSE rejected: token no longer valid');
    stopped = true;
    clearWatchdog();
    invalidateSkybridgeSession(opts.ctx);
    signalAuthRequired(opts.ctx, 'token_rejected', 'skybridge token 已失效，请重新登录');
    return true;
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    // Single clear point for every reconnect path (onError, subscribe-threw
    // catch, idle timeout): we're leaving the connected state, so there's no
    // live stream to watch until the next onOpen re-arms it.
    clearWatchdog();
    if (retryHandle) return; // already scheduled
    const base = backoffFor(retryAttempt);
    retryAttempt += 1;
    const delay = jitter(base);
    retryHandle = schedule(() => {
      retryHandle = null;
      connect();
    }, delay);
  }

  return {
    start: () => connect(),
    stop: () => {
      stopped = true;
      try {
        unsubscribe?.();
      } catch {
        // best-effort
      }
      unsubscribe = null;
      retryHandle?.cancel();
      retryHandle = null;
      clearWatchdog();
    },
    triggerReconnect: () => {
      // P5-c §3.2: short-circuit the current backoff window. Only acts
      // when we're actually waiting on a retry — never re-subscribes
      // while already connected, never resurrects a stopped bridge.
      if (stopped) return;
      if (!retryHandle) return;
      retryHandle.cancel();
      retryHandle = null;
      opts.logger.info({ kind: 'sse' }, 'triggerReconnect: short-circuit backoff');
      connect();
    },
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
