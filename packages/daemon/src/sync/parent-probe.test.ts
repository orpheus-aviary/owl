/**
 * P5-d Phase 6 — parent-process probe tests.
 *
 * Fake setInterval / clearInterval + a programmable kill stub so the
 * suite never touches real timers or process signals.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Logger } from '@owl/core';
import { type ParentProbeHandle, startParentProbe } from './parent-probe.js';

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

interface FakeTimerEnv {
  tickFn: (() => void) | null;
  // biome-ignore lint/suspicious/noExplicitAny: opaque timer handle
  setInterval: any;
  // biome-ignore lint/suspicious/noExplicitAny: opaque timer handle
  clearInterval: any;
  cleared: number;
}

function fakeTimers(): FakeTimerEnv {
  const env: FakeTimerEnv = {
    tickFn: null,
    cleared: 0,
    setInterval: (fn: () => void, _ms: number) => {
      env.tickFn = fn;
      return { unref: () => undefined };
    },
    clearInterval: (_timer: unknown) => {
      env.cleared += 1;
      env.tickFn = null;
    },
  };
  return env;
}

function errnoError(code: string): Error {
  const err = new Error(code);
  (err as Error & { code?: string }).code = code;
  return err;
}

describe('startParentProbe (P5-d Phase 6)', () => {
  it('triggers onParentGone + stops the timer on ESRCH', () => {
    const timers = fakeTimers();
    const logger = silentLogger();
    let goneCalled = 0;

    const handle: ParentProbeHandle = startParentProbe(
      99999,
      () => {
        goneCalled += 1;
      },
      logger,
      {
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        kill: (_pid, _sig) => {
          throw errnoError('ESRCH');
        },
      },
    );

    // First tick — parent gone.
    timers.tickFn?.();
    assert.equal(goneCalled, 1);
    assert.equal(timers.cleared, 1, 'tick must clear its own interval before callback');

    // Subsequent stop() is a no-op (already self-stopped).
    handle.stop();
    assert.equal(timers.cleared, 1);
    assert.equal(goneCalled, 1, 'no further callback');
  });

  it('treats EPERM as alive — does NOT trigger onParentGone', () => {
    const timers = fakeTimers();
    let goneCalled = 0;

    startParentProbe(
      1, // init / launchd-ish pid we wouldn't have perms for
      () => {
        goneCalled += 1;
      },
      silentLogger(),
      {
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        kill: (_pid, _sig) => {
          throw errnoError('EPERM');
        },
      },
    );

    timers.tickFn?.();
    timers.tickFn?.();
    timers.tickFn?.();
    assert.equal(goneCalled, 0);
    assert.equal(timers.cleared, 0, 'EPERM must not cancel the timer');
  });

  it('stays alive when kill(0) succeeds (parent reachable)', () => {
    const timers = fakeTimers();
    let killCalls = 0;

    startParentProbe(
      12345,
      () => {
        throw new Error('parent should be reachable in this test');
      },
      silentLogger(),
      {
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        kill: () => {
          killCalls += 1;
        },
      },
    );

    timers.tickFn?.();
    timers.tickFn?.();
    assert.equal(killCalls, 2);
    assert.equal(timers.cleared, 0);
  });

  it('stop() clears the timer and is idempotent', () => {
    const timers = fakeTimers();
    const handle = startParentProbe(12345, () => undefined, silentLogger(), {
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      kill: () => undefined,
    });

    handle.stop();
    handle.stop();
    assert.equal(timers.cleared, 1, 'clearInterval invoked exactly once');
  });

  it('catches a throwing onParentGone callback without crashing the probe', () => {
    const timers = fakeTimers();
    const logger = silentLogger();

    startParentProbe(
      99999,
      () => {
        throw new Error('callback exploded');
      },
      logger,
      {
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        kill: () => {
          throw errnoError('ESRCH');
        },
      },
    );

    assert.doesNotThrow(() => timers.tickFn?.());
    assert.ok(
      logger.lines.some((l) => l.startsWith('error') && l.includes('onParentGone threw')),
      'callback throw is logged at error level',
    );
  });
});
