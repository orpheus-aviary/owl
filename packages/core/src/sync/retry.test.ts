import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_JITTER_MS,
  DEFAULT_MAX_RETRIES,
  defaultIsRetryable,
  withRetry,
} from './retry.js';

// ─── Synthetic errors that mirror @skybridge/client's ApiError / NetworkError ───

class FakeApiError extends Error {
  override name = 'ApiError';
  status: number;
  constructor(status: number, message = `HTTP ${status}`) {
    super(message);
    this.status = status;
  }
}

class FakeNetworkError extends Error {
  override name = 'NetworkError';
  constructor(message = 'network down') {
    super(message);
  }
}

class FakeOtherError extends Error {
  override name = 'OtherError';
}

// ─── tests ────────────────────────────────────────────────────────────

describe('defaultIsRetryable (P5-c §2.3)', () => {
  it('treats ApiError 429 and 5xx as retryable', () => {
    assert.equal(defaultIsRetryable(new FakeApiError(429)), true);
    assert.equal(defaultIsRetryable(new FakeApiError(500)), true);
    assert.equal(defaultIsRetryable(new FakeApiError(502)), true);
    assert.equal(defaultIsRetryable(new FakeApiError(599)), true);
  });

  it('treats NetworkError as retryable', () => {
    assert.equal(defaultIsRetryable(new FakeNetworkError()), true);
    // FetchError name also accepted (some platforms surface fetch as FetchError)
    const fetchErr = new FakeNetworkError();
    fetchErr.name = 'FetchError';
    assert.equal(defaultIsRetryable(fetchErr), true);
  });

  it('does NOT retry 401 or other 4xx', () => {
    assert.equal(defaultIsRetryable(new FakeApiError(401)), false);
    assert.equal(defaultIsRetryable(new FakeApiError(403)), false);
    assert.equal(defaultIsRetryable(new FakeApiError(404)), false);
    assert.equal(defaultIsRetryable(new FakeApiError(409)), false);
  });

  it('does NOT retry non-ApiError / non-NetworkError throws', () => {
    assert.equal(defaultIsRetryable(new FakeOtherError()), false);
    assert.equal(defaultIsRetryable(new Error('plain')), false);
    assert.equal(defaultIsRetryable(null), false);
    assert.equal(defaultIsRetryable(undefined), false);
    assert.equal(defaultIsRetryable('string'), false);
  });
});

describe('withRetry exhaust + success paths (P5-c §2.3)', () => {
  // sleep impl that records the requested ms instead of waiting — keeps
  // tests at microsecond speed AND lets us inspect the backoff schedule.
  function recordingSleep(): { sleep: (ms: number) => Promise<void>; recorded: number[] } {
    const recorded: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      recorded.push(ms);
    };
    return { sleep, recorded };
  }

  it('returns the first successful value with no retries when fn succeeds first try', async () => {
    let calls = 0;
    const { sleep, recorded } = recordingSleep();
    const result = await withRetry(
      async () => {
        calls += 1;
        return 'ok';
      },
      { sleep, random: () => 0 },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
    assert.deepEqual(recorded, [], 'no sleeps when no retry');
  });

  it('5 retries → 6 attempts total — first 5 throw retryable, 6th succeeds', async () => {
    let calls = 0;
    const { sleep, recorded } = recordingSleep();
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 6) throw new FakeApiError(429);
        return 'recovered';
      },
      { sleep, random: () => 0 },
    );
    assert.equal(result, 'recovered');
    assert.equal(calls, 6, '5 retries + 1 initial = 6 attempts');
    assert.deepEqual(recorded, [1000, 2000, 4000, 8000, 16000], 'backoff ladder');
  });

  it('rethrows the LAST raw error after exhaustion — does NOT wrap as RetryExhaustedError', async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    let caught: unknown;
    try {
      await withRetry(
        async () => {
          calls += 1;
          throw new FakeApiError(503, `5xx attempt ${calls}`);
        },
        { sleep, random: () => 0 },
      );
    } catch (err) {
      caught = err;
    }
    assert.equal(calls, 6, '6 attempts before giving up');
    assert.ok(caught instanceof FakeApiError);
    assert.equal((caught as FakeApiError).name, 'ApiError', 'name preserved');
    assert.equal(
      (caught as FakeApiError).status,
      503,
      '.status preserved for manual.ts:130 translator',
    );
    assert.equal((caught as Error).message, '5xx attempt 6', 'last attempt error surfaced');
  });

  it('401 throws immediately on the first attempt — no retries, no backoff', async () => {
    const { sleep, recorded } = recordingSleep();
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new FakeApiError(401);
        },
        { sleep, random: () => 0 },
      ),
      { name: 'ApiError', status: 401 },
    );
    assert.equal(calls, 1);
    assert.deepEqual(recorded, [], '401 does not enter backoff');
  });

  it('non-retryable error from a custom isRetryable predicate also throws immediately', async () => {
    const { sleep, recorded } = recordingSleep();
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new FakeApiError(500);
        },
        {
          sleep,
          random: () => 0,
          isRetryable: () => false,
        },
      ),
      { name: 'ApiError', status: 500 },
    );
    assert.equal(calls, 1);
    assert.deepEqual(recorded, []);
  });

  it('NetworkError retries the same as 5xx', async () => {
    const { sleep, recorded } = recordingSleep();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new FakeNetworkError();
        return 'ok';
      },
      { sleep, random: () => 0 },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(recorded, [1000, 2000]);
  });
});

describe('withRetry backoff details (P5-c §2.3)', () => {
  it('jitter adds [0, jitterMs) random ms per sleep', async () => {
    const recorded: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      recorded.push(ms);
    };
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new FakeApiError(503);
        },
        { sleep, random: () => 0.5, jitterMs: 500, maxRetries: 2 },
      ),
    );
    // 0.5 * 500 = 250ms jitter on each of 2 retries
    assert.deepEqual(recorded, [1250, 2250]);
  });

  it('jitter respects jitterMs=0 (deterministic backoff)', async () => {
    const recorded: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      recorded.push(ms);
    };
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new FakeApiError(503);
        },
        { sleep, random: () => 0.99, jitterMs: 0, maxRetries: 3 },
      ),
    );
    assert.deepEqual(recorded, [1000, 2000, 4000], 'zero jitter = pure ladder');
  });

  it('backoff table caps at last entry beyond its length (matches plan §3.3)', async () => {
    const recorded: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      recorded.push(ms);
    };
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new FakeApiError(503);
        },
        {
          sleep,
          random: () => 0,
          maxRetries: 7, // beyond the 5-step default ladder
        },
      ),
    );
    // 7 retries, ladder is [1,2,4,8,16] → after step 5 (16s) it caps at 16s
    assert.deepEqual(recorded, [1000, 2000, 4000, 8000, 16000, 16000, 16000]);
  });

  it('exposes sensible defaults', () => {
    assert.equal(DEFAULT_MAX_RETRIES, 5);
    assert.deepEqual([...DEFAULT_BACKOFF_MS], [1000, 2000, 4000, 8000, 16000]);
    assert.equal(DEFAULT_JITTER_MS, 500);
  });

  it('logger.warn fires once per retry attempt with attempt counter', async () => {
    const lines: object[] = [];
    const logger = {
      warn: (obj: object, _msg: string) => {
        lines.push(obj);
      },
    };
    const { sleep } = (() => {
      const out = { sleep: async (_ms: number) => {} };
      return out;
    })();

    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new FakeApiError(503);
        },
        { sleep, random: () => 0, logger, maxRetries: 3 },
      ),
    );
    assert.equal(lines.length, 3, 'one warn per retry attempt');
    assert.equal((lines[0] as { attempt: number }).attempt, 1);
    assert.equal((lines[2] as { attempt: number }).attempt, 3);
  });
});
