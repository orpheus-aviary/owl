import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DEFAULT_CONFIG, type Logger, type OwlConfig } from '@owl/core';
import type { AppContext } from '../context.js';
import { createSyncScheduler } from './scheduler.js';

// ─── Test doubles ────────────────────────────────────────────────────

interface FakeIntervalEntry {
  cb: () => void;
  ms: number;
  cleared: boolean;
  unrefCalled: boolean;
}

class FakeTimers {
  pending: FakeIntervalEntry[] = [];
  // Use a stand-in for NodeJS.Timeout that surfaces unref/cleared for asserts.
  setInterval = ((cb: () => void, ms: number): unknown => {
    const entry: FakeIntervalEntry = { cb, ms, cleared: false, unrefCalled: false };
    this.pending.push(entry);
    return {
      _entry: entry,
      unref(): void {
        entry.unrefCalled = true;
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: matches global setInterval shape narrow enough
  }) as any;
  clearInterval = ((handle: unknown): void => {
    const entry = (handle as { _entry?: FakeIntervalEntry })._entry;
    if (entry) entry.cleared = true;
    // biome-ignore lint/suspicious/noExplicitAny: matches global clearInterval shape
  }) as any;
  /** Fire the only registered tick callback synchronously. */
  fireOnce(): void {
    const entry = this.pending.find((e) => !e.cleared);
    if (!entry) throw new Error('no live interval to fire');
    entry.cb();
  }
}

function silentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

function makeCtx(syncInterval: number | undefined): AppContext {
  const config: OwlConfig = {
    ...DEFAULT_CONFIG,
    sync: { interval_min: syncInterval ?? DEFAULT_CONFIG.sync.interval_min },
  };
  // The scheduler only touches ctx.config.sync; everything else can be a stub.
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  return { config } as any;
}

// ─── tests ────────────────────────────────────────────────────────────

describe('createSyncScheduler (P5-c Step 9)', () => {
  let timers: FakeTimers;

  beforeEach(() => {
    timers = new FakeTimers();
  });

  afterEach(() => {
    // tests that start a real scheduler should always call stop(), but
    // double-clear is harmless.
    for (const e of timers.pending) {
      e.cleared = true;
    }
  });

  it('starts an interval at interval_min × 60_000 ms and calls runSync each tick', async () => {
    const calls: number[] = [];
    const handle = createSyncScheduler({
      ctx: makeCtx(5),
      logger: silentLogger(),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      runSync: async () => {
        calls.push(Date.now());
      },
    });

    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0]?.ms, 5 * 60_000, '5 min in ms');

    timers.fireOnce();
    // runSync is async; let the microtask drain so `running` resets.
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1);

    timers.fireOnce();
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2);

    handle.stop();
  });

  it('calls .unref() on the timer handle so daemon can exit cleanly', () => {
    const handle = createSyncScheduler({
      ctx: makeCtx(5),
      logger: silentLogger(),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      runSync: async () => {},
    });
    assert.equal(timers.pending[0]?.unrefCalled, true, 'unref must be invoked at construction');
    handle.stop();
  });

  it('stop() clears the interval; subsequent .stop() calls are tolerated', () => {
    const handle = createSyncScheduler({
      ctx: makeCtx(5),
      logger: silentLogger(),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      runSync: async () => {},
    });
    handle.stop();
    assert.equal(timers.pending[0]?.cleared, true, 'interval cleared by stop');
    // second stop() does no harm (calls clearInterval again, no throw)
    assert.doesNotThrow(() => handle.stop());
  });

  it('disabled when interval_min <= 0 — no setInterval call, stop() is a noop', () => {
    const handle = createSyncScheduler({
      ctx: makeCtx(0),
      logger: silentLogger(),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      runSync: async () => {
        throw new Error('runSync must not be called when disabled');
      },
    });
    assert.equal(timers.pending.length, 0, 'no interval scheduled');
    assert.doesNotThrow(() => handle.stop());
  });

  it('skips a tick when the previous round is still in flight (no overlap)', async () => {
    const state = { inFlight: false, runCalls: 0, release: null as (() => void) | null };
    const handle = createSyncScheduler({
      ctx: makeCtx(5),
      logger: silentLogger(),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      runSync: async () => {
        state.runCalls += 1;
        state.inFlight = true;
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
        state.inFlight = false;
      },
    });

    // First tick — starts a slow round.
    timers.fireOnce();
    await new Promise((r) => setImmediate(r));
    assert.equal(state.runCalls, 1);
    assert.equal(state.inFlight, true);

    // Second tick fires while the first is still pending — must be skipped.
    timers.fireOnce();
    await new Promise((r) => setImmediate(r));
    assert.equal(state.runCalls, 1, 'overlapping tick was skipped');

    // Release the first round; next tick should run again.
    state.release?.();
    await new Promise((r) => setImmediate(r));
    timers.fireOnce();
    await new Promise((r) => setImmediate(r));
    assert.equal(state.runCalls, 2);

    handle.stop();
  });

  it('rejected runSync does not kill the timer — next tick still fires', async () => {
    let runCalls = 0;
    const handle = createSyncScheduler({
      ctx: makeCtx(5),
      logger: silentLogger(),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      runSync: async () => {
        runCalls += 1;
        throw new Error('server 500');
      },
    });

    timers.fireOnce();
    await new Promise((r) => setImmediate(r));
    timers.fireOnce();
    await new Promise((r) => setImmediate(r));

    assert.equal(runCalls, 2, 'second tick fires despite first rejection');
    handle.stop();
  });
});
