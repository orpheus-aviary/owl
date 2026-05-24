/**
 * P5-c §3.2 — onError-window health probe for the SSE bridge.
 *
 * Only runs while the bridge is in its `onError → backoff → reconnect`
 * window (started by `sse-bridge.ts` when onError fires; stopped on
 * onOpen). Polls `GET ${serverUrl}/health` every 10s (P5-c plan §3.2
 * decision: 10s rather than 30s because SSE backoff caps at 30s — a 10s
 * probe gets 2-3 chances to recover before SSE would naturally reconnect).
 *
 * Probe success → call `onRecover()` and stop. `bridge-lifecycle` wires
 * onRecover to `bridge.triggerReconnect()`, which cancels the pending
 * retry timer and immediately calls connect(); SSE onOpen runs the
 * catch-up sync once the new connection lands.
 *
 * Probe failure → silent (debug log); next tick retries. The bridge's
 * own `[2,4,8,16,30]s + jitter` backoff continues independently —
 * whichever recovers first wins.
 *
 * `setInterval(...).unref()` so daemon process can exit cleanly without
 * waiting up to 10s for the next probe tick after shutdown.
 *
 * Does NOT cover the "SSE connected but server stopped pushing events"
 * case (downstream stall). That requires server keepalive ping + client
 * idle watchdog and is explicitly out of scope for P5-c (see plan §1.4).
 */

import type { Logger } from '@owl/core';

export interface HealthProbeOptions {
  serverUrl: string;
  logger: Logger;
  onRecover: () => void;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Polling interval (ms). Default 10_000 per P5-c §3.2. */
  intervalMs?: number;
  /** Per-request timeout (ms). Default 3_000. */
  timeoutMs?: number;
  /** Override `setInterval` for fake-timer tests. */
  setInterval?: typeof globalThis.setInterval;
  /** Override `clearInterval` for fake-timer tests. */
  clearInterval?: typeof globalThis.clearInterval;
}

export interface HealthProbe {
  /**
   * Begin polling. Called by sse-bridge.onError. Idempotent — calling
   * twice without an intervening stop() is a no-op (existing timer kept).
   */
  start(): void;
  /**
   * Stop polling. Called by sse-bridge.onOpen on successful reconnect,
   * by cli.ts shutdown, and by the probe itself after a successful
   * /health response. Idempotent.
   */
  stop(): void;
}

export const DEFAULT_PROBE_INTERVAL_MS = 10_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

export function createHealthProbe(opts: HealthProbeOptions): HealthProbe {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const intervalMs = opts.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const setIntervalFn = opts.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = opts.clearInterval ?? globalThis.clearInterval;
  // Strip a trailing slash from the configured server URL so concatenating
  // /health doesn't double up.
  const healthUrl = `${opts.serverUrl.replace(/\/+$/, '')}/health`;

  let timer: ReturnType<typeof setIntervalFn> | null = null;
  let probing = false;

  async function tick(): Promise<void> {
    if (probing) {
      // Previous probe still in flight (server hung past timeoutMs is the
      // realistic case). Skip this tick rather than stack outstanding fetches.
      return;
    }
    probing = true;
    try {
      const res = await fetchFn(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) {
        opts.logger.info({ kind: 'health-probe' }, 'health-probe ok, forcing reconnect');
        // Stop FIRST so onRecover → bridge.triggerReconnect → onOpen doesn't
        // try to re-stop a probe we still believe is running. stop() is
        // idempotent so the eventual onOpen-driven stop is also harmless.
        stop();
        opts.onRecover();
      } else {
        opts.logger.debug(
          { kind: 'health-probe', status: res.status },
          'health-probe non-2xx, will retry',
        );
      }
    } catch (err) {
      opts.logger.debug(
        { kind: 'health-probe', err: errorMessage(err) },
        'health-probe fetch failed, will retry',
      );
    } finally {
      probing = false;
    }
  }

  function start(): void {
    if (timer !== null) return; // idempotent
    opts.logger.info({ kind: 'health-probe', intervalMs, url: healthUrl }, 'health-probe started');
    timer = setIntervalFn(() => {
      void tick();
    }, intervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  function stop(): void {
    if (timer === null) return; // idempotent
    clearIntervalFn(timer);
    timer = null;
    opts.logger.info({ kind: 'health-probe' }, 'health-probe stopped');
  }

  return { start, stop };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
