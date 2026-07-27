/**
 * 0.6.2 W2 — the daemon-side throttle around `pruneSyncedChanges`.
 *
 * The pruning logic itself is covered in core (`sync/retention.test.ts`); what
 * matters here is that the daemon calls it at most once an hour per database,
 * keeps the schedule moving when it throws, and forgets the schedule when a
 * profile switch swaps the db under the (in-place mutated) AppContext.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { DEFAULT_CONFIG, type Logger, type OwlConfig, type PruneResult } from '@owl/core';
import type { AppContext } from '../context.js';
import { maybePruneOutbox, resetOutboxPruneThrottle } from './manual.js';

const ENDPOINT = 'http://sync.example.test';
const HOUR = 60 * 60 * 1000;

function silentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

function makeCtx(): AppContext {
  const config: OwlConfig = structuredClone(DEFAULT_CONFIG);
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  return { config, logger: silentLogger() } as any;
}

const pruned = (deleted: number): PruneResult => ({
  pruned: true,
  deleted,
  cutoff: 0,
  pulledSeq: 0,
  safeAfter: 0,
});

let calls: string[];
let clockMs: number;
const clock = (): number => clockMs;

beforeEach(() => {
  calls = [];
  clockMs = 1_000_000;
});

function counting(result: PruneResult = pruned(3)) {
  return (_ctx: AppContext, endpoint: string): PruneResult => {
    calls.push(endpoint);
    return result;
  };
}

describe('maybePruneOutbox throttle (0.6.2 W2)', () => {
  it('prunes on the first round and then stays quiet for an hour', () => {
    const ctx = makeCtx();

    maybePruneOutbox(ctx, ENDPOINT, counting(), clock);
    clockMs += HOUR - 1;
    maybePruneOutbox(ctx, ENDPOINT, counting(), clock);

    assert.deepEqual(calls, [ENDPOINT]);
  });

  it('prunes again once the hour has passed', () => {
    const ctx = makeCtx();

    maybePruneOutbox(ctx, ENDPOINT, counting(), clock);
    clockMs += HOUR;
    maybePruneOutbox(ctx, ENDPOINT, counting(), clock);

    assert.equal(calls.length, 2);
  });

  it('swallows a failure and still advances the schedule', () => {
    const ctx = makeCtx();
    const throwing = (): PruneResult => {
      calls.push('throw');
      throw new Error('disk on fire');
    };

    assert.doesNotThrow(() => maybePruneOutbox(ctx, ENDPOINT, throwing, clock));
    clockMs += 1000;
    maybePruneOutbox(ctx, ENDPOINT, throwing, clock);

    assert.deepEqual(calls, ['throw'], 'a failing prune must not retry every sync round');
  });

  it('a skip result is not an error and does not re-run within the hour', () => {
    const ctx = makeCtx();

    maybePruneOutbox(ctx, ENDPOINT, counting({ pruned: false, reason: 'no_cursor' }), clock);
    clockMs += 60_000;
    maybePruneOutbox(ctx, ENDPOINT, counting(), clock);

    assert.equal(calls.length, 1);
  });

  it('a profile switch clears the throttle for the new database', () => {
    const ctx = makeCtx();

    maybePruneOutbox(ctx, ENDPOINT, counting(), clock);
    resetOutboxPruneThrottle(ctx);
    maybePruneOutbox(ctx, 'http://other.example.test', counting(), clock);

    assert.deepEqual(calls, [ENDPOINT, 'http://other.example.test']);
  });

  it('two contexts keep independent schedules', () => {
    maybePruneOutbox(makeCtx(), ENDPOINT, counting(), clock);
    maybePruneOutbox(makeCtx(), ENDPOINT, counting(), clock);

    assert.equal(calls.length, 2);
  });
});
