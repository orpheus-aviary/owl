/**
 * P5-c §2.3 — exponential-backoff retry wrapper for skybridge HTTP calls.
 *
 * Wraps `client.pushChanges` / `client.pullChanges` so transient 429 /
 * 5xx / NetworkError responses don't immediately flip the sync status
 * indicator to `error`. The retry state is internal to one `runSync()`
 * invocation; it does NOT interact with the SSE bridge reconnect
 * backoff or the §3.2 health probe — those handle connection-level
 * faults, this handles request-level faults.
 *
 * Decision matrix (§3.3):
 *
 *   ApiError.status === 429        retry
 *   ApiError.status 5xx            retry
 *   NetworkError / FetchError      retry
 *   ApiError.status 4xx (incl 401) throw immediately
 *   anything else                  throw immediately
 *
 * 401 is intentionally NOT retried — `manual.ts` invalidates the
 * cached skybridge session on 401 so the next round re-bootstraps.
 * Retrying inside withRetry would just hit 401 five more times.
 *
 * Error-propagation invariant (P5-c invariant 28): when retries are
 * exhausted, withRetry rethrows the LAST raw error untouched — never
 * wraps it as RetryExhaustedError. Reason: `manual.ts:130`
 * `translateSkybridgeError` / `statusForError` reads `ApiError.status`;
 * a wrapper would erase the status and 429 / 5xx would all surface to
 * the UI as generic 500.
 *
 * Naming: code uses `maxRetries` (number of retry attempts NOT counting
 * the first call) — total attempts = maxRetries + 1. Default 5 retries
 * → 6 attempts → at most ~31s of cumulative backoff (1+2+4+8+16s
 * intervals, plus 0-500ms jitter each). Operator-visible retry counter
 * stays in daemon log only; not surfaced via SyncStatusSnapshot.
 *
 * No throw-time logging in core: this module is part of `@owl/core`
 * which stays logger-optional (loadConfig pure-read invariant). Pass
 * `logger` if you want per-attempt diagnostics; without it the retry
 * loop is silent and only the final outcome surfaces to the caller.
 */

export const DEFAULT_MAX_RETRIES = 5;
export const DEFAULT_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000];
export const DEFAULT_JITTER_MS = 500;

export interface RetryLogger {
  warn: (obj: object, msg: string) => void;
}

export interface WithRetryOptions {
  /** Total retries AFTER the first attempt. Total attempts = maxRetries + 1. */
  maxRetries?: number;
  /**
   * Backoff base for each retry attempt (ms). `backoffMs[i]` is read
   * for the i-th retry; if i exceeds length, the last entry is reused.
   */
  backoffMs?: readonly number[];
  /** Random jitter in ms added to each backoff (uniform [0, jitterMs]). */
  jitterMs?: number;
  /** Per-attempt log target. Optional — silent when omitted. */
  logger?: RetryLogger;
  /** Override sleep mechanism. Used by tests to skip real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Override the random source. Used by tests to pin jitter to 0. */
  random?: () => number;
  /**
   * Override the retryability predicate. Default behaves per §3.3
   * (429 / 5xx ApiError + NetworkError). Tests override to inject
   * deterministic decisions.
   */
  isRetryable?: (err: unknown) => boolean;
}

/**
 * Default per §3.3 — ApiError with status 429 or 5xx (incl 502, 503,
 * 504), or any NetworkError / FetchError (offline / DNS failures /
 * connect timeouts). 4xx including 401 falls through to throw.
 *
 * Duck-typed because `@owl/core` does NOT import `@skybridge/client` —
 * the runtime instance check would create a hard module dep we've kept
 * out of core since P4 Phase 1.
 */
export function defaultIsRetryable(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'NetworkError' || name === 'FetchError') return true;
  if (name === 'ApiError') {
    const status = (err as { status?: unknown }).status;
    if (typeof status !== 'number') return false;
    return status === 429 || (status >= 500 && status < 600);
  }
  return false;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffAt(retryIndex: number, table: readonly number[]): number {
  const last = table[table.length - 1];
  if (last === undefined) return 0;
  return table[retryIndex] ?? last;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: WithRetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const jitterMs = opts.jitterMs ?? DEFAULT_JITTER_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const exhausted = attempt >= maxRetries;
      if (!isRetryable(err) || exhausted) {
        throw err;
      }
      const base = backoffAt(attempt, backoffMs);
      const wait = base + Math.floor(random() * jitterMs);
      opts.logger?.warn(
        { kind: 'retry', attempt: attempt + 1, of: maxRetries + 1, waitMs: wait },
        'sync HTTP retry scheduled',
      );
      await sleep(wait);
    }
  }
  // Unreachable: the loop either returns or throws on the last
  // iteration. TS can't infer that exhaustion always throws, so we
  // rethrow as a defence-in-depth.
  throw lastErr;
}
