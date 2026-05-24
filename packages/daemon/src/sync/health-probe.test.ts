import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Logger } from '@owl/core';
import { createHealthProbe } from './health-probe.js';

// ─── Test doubles ─────────────────────────────────────────────────────

interface FakeIntervalEntry {
  cb: () => void;
  ms: number;
  cleared: boolean;
  unrefCalled: boolean;
}

class FakeTimers {
  pending: FakeIntervalEntry[] = [];
  setInterval = ((cb: () => void, ms: number): unknown => {
    const entry: FakeIntervalEntry = { cb, ms, cleared: false, unrefCalled: false };
    this.pending.push(entry);
    return {
      _entry: entry,
      unref(): void {
        entry.unrefCalled = true;
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: matches global setInterval shape
  }) as any;
  clearInterval = ((handle: unknown): void => {
    const entry = (handle as { _entry?: FakeIntervalEntry })._entry;
    if (entry) entry.cleared = true;
    // biome-ignore lint/suspicious/noExplicitAny: matches global clearInterval shape
  }) as any;
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

function okResponse(): Response {
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function badResponse(status: number): Response {
  return new Response(JSON.stringify({ error: 'busy' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ─── tests ────────────────────────────────────────────────────────────

describe('createHealthProbe (P5-c Step 10)', () => {
  let timers: FakeTimers;

  beforeEach(() => {
    timers = new FakeTimers();
  });

  afterEach(() => {
    for (const e of timers.pending) {
      e.cleared = true;
    }
  });

  it('start() registers a 10s setInterval with .unref()', () => {
    const probe = createHealthProbe({
      serverUrl: 'https://skybridge.example',
      logger: silentLogger(),
      onRecover: () => {},
      fetchImpl: async () => okResponse(),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    probe.start();
    assert.equal(timers.pending.length, 1);
    assert.equal(timers.pending[0]?.ms, 10_000, 'default 10s per §3.2');
    assert.equal(timers.pending[0]?.unrefCalled, true, 'unref so daemon exits cleanly');
    probe.stop();
  });

  it('successful /health → onRecover called + probe self-stops', async () => {
    const fetched: string[] = [];
    let recoverCalls = 0;
    const probe = createHealthProbe({
      serverUrl: 'https://skybridge.example',
      logger: silentLogger(),
      onRecover: () => {
        recoverCalls += 1;
      },
      fetchImpl: async (url) => {
        fetched.push(String(url));
        return okResponse();
      },
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    probe.start();
    timers.fireOnce();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(fetched, ['https://skybridge.example/health']);
    assert.equal(recoverCalls, 1, 'onRecover invoked on 200');
    assert.equal(timers.pending[0]?.cleared, true, 'probe stopped itself after recovery');
  });

  it('strips a trailing slash from serverUrl when composing /health', async () => {
    const fetched: string[] = [];
    const probe = createHealthProbe({
      serverUrl: 'https://skybridge.example/',
      logger: silentLogger(),
      onRecover: () => {},
      fetchImpl: async (url) => {
        fetched.push(String(url));
        return okResponse();
      },
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    probe.start();
    timers.fireOnce();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(fetched, ['https://skybridge.example/health']);
    probe.stop();
  });

  it('non-2xx response keeps the probe running for the next tick', async () => {
    let recoverCalls = 0;
    let fetches = 0;
    const probe = createHealthProbe({
      serverUrl: 'https://skybridge.example',
      logger: silentLogger(),
      onRecover: () => {
        recoverCalls += 1;
      },
      fetchImpl: async () => {
        fetches += 1;
        return badResponse(503);
      },
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    probe.start();
    timers.fireOnce();
    await new Promise((r) => setImmediate(r));
    timers.fireOnce();
    await new Promise((r) => setImmediate(r));
    assert.equal(fetches, 2, 'next tick still ran after 503');
    assert.equal(recoverCalls, 0, 'no recover on non-2xx');
    assert.equal(timers.pending[0]?.cleared, false, 'probe still alive');
    probe.stop();
  });

  it('fetch rejection (network down) keeps the probe running', async () => {
    let fetches = 0;
    const probe = createHealthProbe({
      serverUrl: 'https://skybridge.example',
      logger: silentLogger(),
      onRecover: () => {
        throw new Error('must not be called');
      },
      fetchImpl: async () => {
        fetches += 1;
        throw new TypeError('network down');
      },
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    probe.start();
    timers.fireOnce();
    await new Promise((r) => setImmediate(r));
    timers.fireOnce();
    await new Promise((r) => setImmediate(r));
    assert.equal(fetches, 2, 'rejection does not poison the timer');
    assert.equal(timers.pending[0]?.cleared, false);
    probe.stop();
  });

  it('start() is idempotent — second call does not create a second interval', () => {
    const probe = createHealthProbe({
      serverUrl: 'https://skybridge.example',
      logger: silentLogger(),
      onRecover: () => {},
      fetchImpl: async () => okResponse(),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    probe.start();
    probe.start();
    assert.equal(timers.pending.length, 1);
    probe.stop();
  });

  it('stop() is idempotent — second call does not throw', () => {
    const probe = createHealthProbe({
      serverUrl: 'https://skybridge.example',
      logger: silentLogger(),
      onRecover: () => {},
      fetchImpl: async () => okResponse(),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    probe.start();
    probe.stop();
    assert.doesNotThrow(() => probe.stop());
  });

  it('skips overlapping probe when previous fetch is still in flight', async () => {
    const state: { fetches: number; release: (() => void) | null } = {
      fetches: 0,
      release: null,
    };
    const probe = createHealthProbe({
      serverUrl: 'https://skybridge.example',
      logger: silentLogger(),
      onRecover: () => {},
      fetchImpl: async () => {
        state.fetches += 1;
        await new Promise<void>((resolve) => {
          state.release = resolve;
        });
        return okResponse();
      },
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    probe.start();
    timers.fireOnce(); // starts a slow fetch
    await new Promise((r) => setImmediate(r));
    assert.equal(state.fetches, 1);
    timers.fireOnce(); // second tick while first is still hanging
    await new Promise((r) => setImmediate(r));
    assert.equal(state.fetches, 1, 'overlapping tick was skipped');
    state.release?.();
    await new Promise((r) => setImmediate(r));
    probe.stop();
  });
});
