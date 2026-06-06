import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { type Logger, createDatabase, ensureDeviceId } from '@owl/core';
import type { AppContext } from '../context.js';
import { EventsBus } from '../events/bus.js';
import { backoffFor, createSseBridge } from './sse-bridge.js';
import { getSyncStatusBroadcaster } from './status-broadcaster.js';

// ─── Test doubles ────────────────────────────────────────────────────

interface CapturedHandlers {
  onChange: (latestSeq: number) => void;
  onFrame?: (frame: { event: string; data: string; id?: string }) => void;
  onOpen?: () => void;
  onError?: (err: Error) => void;
}

interface FakeClientOptions {
  /** If true, `subscribeEvents` throws synchronously instead of returning. */
  throwOnSubscribe?: boolean;
}

class FakeRealClient {
  subscribeCalls = 0;
  unsubscribeCalls = 0;
  lastHandlers: CapturedHandlers | null = null;
  constructor(private readonly opts: FakeClientOptions = {}) {}

  // Only the SSE-relevant method is implemented; cast to silence other
  // signatures the RealSkybridgeClient interface declares — sse-bridge only
  // touches subscribeEvents.
  // biome-ignore lint/suspicious/noExplicitAny: structural test double
  subscribeEvents = (_workspaceId: string, handlers: CapturedHandlers): any => {
    this.subscribeCalls += 1;
    if (this.opts.throwOnSubscribe) throw new Error('subscribe threw');
    this.lastHandlers = handlers;
    return () => {
      this.unsubscribeCalls += 1;
    };
  };

  fireOpen(): void {
    this.lastHandlers?.onOpen?.();
  }
  fireChange(latestSeq: number): void {
    this.lastHandlers?.onChange(latestSeq);
  }
  fireFrame(event = 'ping'): void {
    this.lastHandlers?.onFrame?.({ event, data: '{}' });
  }
  fireError(message = 'boom'): void {
    this.lastHandlers?.onError?.(new Error(message));
  }
}

class FakeScheduler {
  pending: { cb: () => void; ms: number }[] = [];
  schedule = (cb: () => void, ms: number): { cancel: () => void } => {
    const entry = { cb, ms };
    this.pending.push(entry);
    return {
      cancel: () => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
      },
    };
  };
  /** Advance the next scheduled callback synchronously. */
  fireNext(): void {
    const next = this.pending.shift();
    if (!next) throw new Error('no scheduled callback');
    next.cb();
  }
}

function silentLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      lines.push(`${level} ${msg ?? ''} ${JSON.stringify(obj)}`);
    };
  return {
    lines,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
  } as Logger & { lines: string[] };
}

/**
 * Make a minimal-but-real AppContext stub. The broadcaster touches
 * `ctx.sqlite` (pending-count query in readSyncStatus) and
 * `ctx.eventsBus.emit`, so we need real instances for those even though
 * the bridge mainly cares about ctx identity for the WeakMap lookup.
 * runManualSync(ctx) is still expected to reject (no session); the
 * bridge's .catch swallows it. Once `@orpheus-aviary/skybridge-client`
 * became a hard runtime dep the dynamic import inside session.ts
 * resolves before the rejection, so manual sync reaches code that
 * touches `ctx.logger.warn`; provide a no-op logger to keep the late
 * `.catch` from blowing up on an `undefined` field.
 */
function makeCtx(): AppContext {
  const { db, sqlite } = createDatabase({ dbPath: ':memory:' });
  ensureDeviceId(db);
  const noopLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub
  return { db, sqlite, eventsBus: new EventsBus(), logger: noopLogger } as any;
}

// ─── tests ───────────────────────────────────────────────────────────

describe('backoffFor (P5-b §6.2)', () => {
  it('returns the expected 2/4/8/16/30s steps', () => {
    assert.equal(backoffFor(0), 2_000);
    assert.equal(backoffFor(1), 4_000);
    assert.equal(backoffFor(2), 8_000);
    assert.equal(backoffFor(3), 16_000);
    assert.equal(backoffFor(4), 30_000);
  });

  it('caps at the 30s step for further retries', () => {
    assert.equal(backoffFor(5), 30_000);
    assert.equal(backoffFor(99), 30_000);
  });
});

describe('createSseBridge — start / stop lifecycle', () => {
  let client: FakeRealClient;
  let sched: FakeScheduler;
  let logger: Logger & { lines: string[] };

  beforeEach(() => {
    client = new FakeRealClient();
    sched = new FakeScheduler();
    logger = silentLogger();
  });

  afterEach(() => {
    // tests should leave no pending timer
  });

  it('start() subscribes once with the workspace id', () => {
    const bridge = createSseBridge({
      realClient: client as never,
      workspaceId: 'ws-1',
      ctx: makeCtx(),
      logger,
      schedule: sched.schedule,
      jitter: (b) => b,
    });
    bridge.start();
    assert.equal(client.subscribeCalls, 1);
    bridge.stop();
    assert.equal(client.unsubscribeCalls, 1);
  });

  it('stop() before any error → no reconnect scheduled', () => {
    const bridge = createSseBridge({
      realClient: client as never,
      workspaceId: 'ws-1',
      ctx: makeCtx(),
      logger,
      schedule: sched.schedule,
      jitter: (b) => b,
    });
    bridge.start();
    bridge.stop();
    assert.equal(sched.pending.length, 0);
  });
});

describe('createSseBridge — reconnect with backoff (P5-b §6.2)', () => {
  let client: FakeRealClient;
  let sched: FakeScheduler;
  let logger: Logger & { lines: string[] };

  beforeEach(() => {
    client = new FakeRealClient();
    sched = new FakeScheduler();
    logger = silentLogger();
  });

  it('onError schedules the next attempt at backoff[n] and increments', () => {
    const bridge = createSseBridge({
      realClient: client as never,
      workspaceId: 'ws-1',
      ctx: makeCtx(),
      logger,
      schedule: sched.schedule,
      jitter: (b) => b, // strip jitter for determinism
    });
    bridge.start();

    client.fireError('e1');
    assert.equal(sched.pending.length, 1);
    assert.equal(sched.pending[0]?.ms, 2_000);

    sched.fireNext(); // reconnect attempt 1 (subscribe again)
    assert.equal(client.subscribeCalls, 2);

    client.fireError('e2');
    assert.equal(sched.pending[0]?.ms, 4_000);

    sched.fireNext();
    client.fireError('e3');
    assert.equal(sched.pending[0]?.ms, 8_000);

    sched.fireNext();
    client.fireError('e4');
    assert.equal(sched.pending[0]?.ms, 16_000);

    sched.fireNext();
    client.fireError('e5');
    assert.equal(sched.pending[0]?.ms, 30_000);

    sched.fireNext();
    client.fireError('e6');
    assert.equal(sched.pending[0]?.ms, 30_000, 'cap at 30s');

    bridge.stop();
  });

  it('onOpen resets the retry counter so the next error starts at 2s again', () => {
    const bridge = createSseBridge({
      realClient: client as never,
      workspaceId: 'ws-1',
      ctx: makeCtx(),
      logger,
      schedule: sched.schedule,
      jitter: (b) => b,
    });
    bridge.start();

    client.fireError('first');
    assert.equal(sched.pending[0]?.ms, 2_000);
    sched.fireNext();
    client.fireError('second');
    assert.equal(sched.pending[0]?.ms, 4_000);
    sched.fireNext();

    // a successful open should reset retryAttempt
    client.fireOpen();
    client.fireError('after-open');
    assert.equal(sched.pending[0]?.ms, 2_000, 'retry counter reset after onOpen');

    bridge.stop();
  });

  it('stop() during pending reconnect cancels the timer', () => {
    const bridge = createSseBridge({
      realClient: client as never,
      workspaceId: 'ws-1',
      ctx: makeCtx(),
      logger,
      schedule: sched.schedule,
      jitter: (b) => b,
    });
    bridge.start();
    client.fireError('e');
    assert.equal(sched.pending.length, 1);
    bridge.stop();
    assert.equal(sched.pending.length, 0);
  });

  // P5-c Step 10: health-probe success calls bridge.triggerReconnect()
  // to short-circuit the current backoff window.
  it('triggerReconnect cancels the pending retry timer and connects immediately', () => {
    const bridge = createSseBridge({
      realClient: client as never,
      workspaceId: 'ws-1',
      ctx: makeCtx(),
      logger,
      schedule: sched.schedule,
      jitter: (b) => b,
    });
    bridge.start();
    client.fireError('disconnect'); // arms a retry timer at 2s
    assert.equal(sched.pending.length, 1);

    bridge.triggerReconnect();
    assert.equal(sched.pending.length, 0, 'pending retry cancelled');
    assert.equal(client.subscribeCalls, 2, 'connect() invoked synchronously');

    bridge.stop();
  });

  it('triggerReconnect is a no-op when no retry is pending (already connected)', () => {
    const bridge = createSseBridge({
      realClient: client as never,
      workspaceId: 'ws-1',
      ctx: makeCtx(),
      logger,
      schedule: sched.schedule,
      jitter: (b) => b,
    });
    bridge.start();
    // No onError fired yet → we're "connected" from the bridge's POV.
    bridge.triggerReconnect();
    assert.equal(client.subscribeCalls, 1, 'no extra connect when no retry pending');
    bridge.stop();
  });

  it('triggerReconnect is a no-op after stop()', () => {
    const bridge = createSseBridge({
      realClient: client as never,
      workspaceId: 'ws-1',
      ctx: makeCtx(),
      logger,
      schedule: sched.schedule,
      jitter: (b) => b,
    });
    bridge.start();
    client.fireError('e');
    bridge.stop();
    bridge.triggerReconnect();
    // bridge.stop already cancelled the retry; triggerReconnect must not
    // resurrect the bridge.
    assert.equal(client.subscribeCalls, 1, 'stopped bridge stays stopped');
  });

  it('onErrorHook fires before scheduleReconnect; onOpenHook fires on (re)connect', () => {
    const calls: string[] = [];
    const bridge = createSseBridge({
      realClient: client as never,
      workspaceId: 'ws-1',
      ctx: makeCtx(),
      logger,
      schedule: sched.schedule,
      jitter: (b) => b,
      onErrorHook: () => calls.push('onError'),
      onOpenHook: () => calls.push('onOpen'),
    });
    bridge.start();
    client.fireOpen();
    client.fireError('e1');
    sched.fireNext();
    client.fireOpen();
    assert.deepEqual(calls, ['onOpen', 'onError', 'onOpen']);
    bridge.stop();
  });

  it('subscribeEvents throwing → schedule reconnect rather than crashing start()', () => {
    const throwing = new FakeRealClient({ throwOnSubscribe: true });
    const bridge = createSseBridge({
      realClient: throwing as never,
      workspaceId: 'ws-1',
      ctx: makeCtx(),
      logger,
      schedule: sched.schedule,
      jitter: (b) => b,
    });
    bridge.start();
    assert.equal(throwing.subscribeCalls, 1, 'one attempted subscribe');
    assert.equal(sched.pending.length, 1, 'reconnect scheduled');
    assert.equal(sched.pending[0]?.ms, 2_000);
    bridge.stop();
  });
});

// ─── idle watchdog (2026-06-06) ──────────────────────────────────────
//
// onError only recovers explicit disconnects. The watchdog covers the
// half-open / downstream-stall case: socket alive but the server stopped
// pushing. Server pings every 25s and the SDK forwards every frame to
// onFrame; we arm a 60s watchdog on open, reset it on each frame, and on
// timeout take the same recovery path as onError.

describe('createSseBridge — idle watchdog (2026-06-06)', () => {
  let client: FakeRealClient;
  let reconnectSched: FakeScheduler;
  let watchdogSched: FakeScheduler;
  let logger: Logger & { lines: string[] };
  let ctx: AppContext;

  beforeEach(() => {
    client = new FakeRealClient();
    reconnectSched = new FakeScheduler();
    watchdogSched = new FakeScheduler();
    logger = silentLogger();
    ctx = makeCtx();
  });

  function makeBridge(hooks: { onErrorHook?: () => void; onOpenHook?: () => void } = {}) {
    return createSseBridge({
      realClient: client as never,
      workspaceId: 'ws-1',
      ctx,
      logger,
      schedule: reconnectSched.schedule,
      armWatchdog: watchdogSched.schedule,
      watchdogMs: 60_000,
      jitter: (b) => b,
      ...hooks,
    });
  }

  it('arms the watchdog on onOpen (not before) at watchdogMs', () => {
    const bridge = makeBridge();
    bridge.start();
    assert.equal(watchdogSched.pending.length, 0, 'not armed before onOpen');
    client.fireOpen();
    assert.equal(watchdogSched.pending.length, 1, 'armed on open');
    assert.equal(watchdogSched.pending[0]?.ms, 60_000);
    bridge.stop();
  });

  it('onFrame resets the watchdog (cancel + re-arm, stays a single timer)', () => {
    const bridge = makeBridge();
    bridge.start();
    client.fireOpen();
    const first = watchdogSched.pending[0];
    client.fireFrame('ping');
    assert.equal(watchdogSched.pending.length, 1, 'still exactly one watchdog timer');
    assert.notEqual(watchdogSched.pending[0], first, 'old timer replaced by a fresh one');
    bridge.stop();
  });

  it('firing aborts the zombie connection and recovers like onError', () => {
    const hookCalls: string[] = [];
    const bridge = makeBridge({ onErrorHook: () => hookCalls.push('onError') });
    bridge.start();
    client.fireOpen();
    assert.equal(watchdogSched.pending.length, 1);

    watchdogSched.fireNext(); // idle timeout

    assert.equal(client.unsubscribeCalls, 1, 'zombie connection aborted');
    assert.deepEqual(hookCalls, ['onError'], 'health probe kicked via onErrorHook');
    assert.equal(reconnectSched.pending.length, 1, 'reconnect scheduled');
    assert.equal(reconnectSched.pending[0]?.ms, 2_000, 'first backoff step');
    assert.equal(getSyncStatusBroadcaster(ctx).snapshot().state, 'offline');
    bridge.stop();
  });

  it('onError clears the watchdog (no stale fire during backoff)', () => {
    const bridge = makeBridge();
    bridge.start();
    client.fireOpen();
    assert.equal(watchdogSched.pending.length, 1);
    client.fireError('drop');
    assert.equal(watchdogSched.pending.length, 0, 'watchdog cleared on explicit error');
    bridge.stop();
  });

  it('stop() clears the watchdog', () => {
    const bridge = makeBridge();
    bridge.start();
    client.fireOpen();
    assert.equal(watchdogSched.pending.length, 1);
    bridge.stop();
    assert.equal(watchdogSched.pending.length, 0);
  });

  it('re-arms the watchdog after a reconnect onOpen', () => {
    const bridge = makeBridge();
    bridge.start();
    client.fireOpen();
    watchdogSched.fireNext(); // watchdog fires → reconnect scheduled
    assert.equal(watchdogSched.pending.length, 0, 'cleared after fire');
    reconnectSched.fireNext(); // backoff elapses → subscribe again
    client.fireOpen(); // new connection opens
    assert.equal(watchdogSched.pending.length, 1, 're-armed on the reconnect open');
    bridge.stop();
  });
});
