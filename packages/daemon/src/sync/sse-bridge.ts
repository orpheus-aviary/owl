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

export interface SseBridge {
  start(): void;
  stop(): void;
}

export interface SseBridgeOptions {
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
          scheduleReconnect();
        },
      });
    } catch (err) {
      opts.logger.warn(
        { kind: 'sse', err: errorMessage(err) },
        'subscribeEvents threw; will retry',
      );
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
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
