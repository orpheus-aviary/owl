import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './db-lock.js';
import { CliError } from './errors.js';

function sqliteBusyError(): Error & { code: string } {
  const err = new Error('database is locked') as Error & { code: string };
  err.code = 'SQLITE_BUSY';
  return err;
}

describe('withRetry', () => {
  it('returns immediately on first-call success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on SQLITE_BUSY and succeeds on later attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(sqliteBusyError())
      .mockRejectedValueOnce(sqliteBusyError())
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn, 'test', { sleep: async () => {} });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws DB_BUSY CliError after 3 retries (4 total attempts)', async () => {
    const fn = vi.fn().mockRejectedValue(sqliteBusyError());
    try {
      await withRetry(fn, 'test-label', { sleep: async () => {} });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe('DB_BUSY');
      expect(cliErr.details?.retries).toBe(3);
      expect(cliErr.details?.label).toBe('test-label');
    }
    // Initial attempt + 3 retries = 4 total calls.
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('propagates non-SQLITE_BUSY errors without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('schema broken'));
    await expect(withRetry(fn, 'x')).rejects.toThrow(/schema broken/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('also retries on SQLITE_BUSY_SNAPSHOT', async () => {
    const err = new Error('snapshot conflict') as Error & { code: string };
    err.code = 'SQLITE_BUSY_SNAPSHOT';
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('done');
    expect(await withRetry(fn, 'snap', { sleep: async () => {} })).toBe('done');
  });
});
