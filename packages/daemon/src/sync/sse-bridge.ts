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
 */

import type { Logger } from '@owl/core';
import type { AppContext } from '../context.js';
import { runManualSync } from './manual.js';
import type { RealSkybridgeClient } from './session.js';
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
  /** Override jitter so tests can pin the delay. */
  jitter?: (base: number) => number;
}

const BACKOFF_STEPS_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

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
  const i = Math.min(retryAttempt, BACKOFF_STEPS_MS.length - 1);
  return BACKOFF_STEPS_MS[i] ?? BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]!;
}

export function createSseBridge(opts: SseBridgeOptions): SseBridge {
  const schedule = opts.schedule ?? defaultSchedule;
  const jitter = opts.jitter ?? defaultJitter;

  let unsubscribe: (() => void) | null = null;
  let retryHandle: { cancel: () => void } | null = null;
  let retryAttempt = 0;
  let stopped = false;

  const broadcaster = getSyncStatusBroadcaster(opts.ctx);

  function connect(): void {
    if (stopped) return;
    try {
      unsubscribe = opts.realClient.subscribeEvents(opts.workspaceId, {
        onChange: (latestSeq) => {
          opts.logger.info({ kind: 'sse', latestSeq }, 'change event');
          runManualSync(opts.ctx).catch((err) => {
            opts.logger.warn(
              { kind: 'sse', err: errorMessage(err) },
              'runManualSync from SSE failed',
            );
          });
        },
        onOpen: () => {
          retryAttempt = 0;
          opts.logger.info({ kind: 'sse' }, 'connected');
          broadcaster.markConnected();
          // P5-c §3.2: stop the health probe as soon as we're back online.
          // Probe.stop() is idempotent so a probe that already self-stopped
          // after triggering this reconnect is harmless.
          opts.onOpenHook?.();
          // Catch-up: server SSE does not replay history. Pull anything
          // accumulated while we were disconnected.
          runManualSync(opts.ctx).catch((err) => {
            opts.logger.warn(
              { kind: 'sse', err: errorMessage(err) },
              'reconnect catch-up sync failed',
            );
          });
        },
        onError: (err) => {
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
      opts.logger.warn(
        { kind: 'sse', err: errorMessage(err) },
        'subscribeEvents threw; will retry',
      );
      broadcaster.markOffline(err);
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
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
