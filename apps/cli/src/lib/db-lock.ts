import { CliError } from './errors.js';

/** Backoff schedule for SQLITE_BUSY: 50ms, 150ms, 400ms. Total bounded ~600ms. */
const BACKOFF_MS = [50, 150, 400];

function isBusyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT';
}

/**
 * Wrap a synchronous-or-async thunk with SQLite BUSY retry.
 *
 * better-sqlite3's internal `busy_timeout=5000` (set in `createDatabase`)
 * already absorbs the common case. This layer provides a second chance
 * for genuinely contended writes — three retries with 50ms / 150ms /
 * 400ms exponential backoff. Non-BUSY errors propagate untouched.
 *
 * `label` surfaces in the `DB_BUSY` error details so users can tell
 * which command exhausted its budget.
 */
export async function withRetry<T>(
  fn: () => T | Promise<T>,
  label: string,
  env: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const sleep = env.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isBusyError(err)) throw err;
      if (attempt === BACKOFF_MS.length) break;
      await sleep(BACKOFF_MS[attempt]);
    }
  }
  const message = lastErr instanceof Error ? lastErr.message : 'SQLITE_BUSY after 3 retries';
  throw new CliError('DB_BUSY', message, {
    label,
    retries: BACKOFF_MS.length,
  });
}
