/**
 * P5-c follow-up #3: focused unit test for `emitSyncLog`, the daemon
 * shim around core `RunSyncLogger`. M6 manual verification noticed
 * lines like `[object Object] sync HTTP retry scheduled` showing up
 * in daemon.log because the previous shim ran `a.map(String).join(' ')`
 * over every arg — pino-style `(obj, msg)` calls from
 * core/sync/retry.ts lost their structure.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emitSyncLog } from './manual.js';

interface Captured {
  obj: Record<string, unknown>;
  msg?: string;
}

function captureEmit(): { emit: (obj: Record<string, unknown>, msg?: string) => void; calls: Captured[] } {
  const calls: Captured[] = [];
  const emit = (obj: Record<string, unknown>, msg?: string): void => {
    calls.push({ obj, msg });
  };
  return { emit, calls };
}

describe('emitSyncLog', () => {
  it('pino-style (obj, msg) merges obj fields and preserves msg', () => {
    const { emit, calls } = captureEmit();
    emitSyncLog(emit, [
      { kind: 'retry', attempt: 2, of: 5, waitMs: 2000 },
      'sync HTTP retry scheduled',
    ]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.obj, {
      kind: 'retry',
      attempt: 2,
      of: 5,
      waitMs: 2000,
    });
    assert.equal(calls[0]?.msg, 'sync HTTP retry scheduled');
  });

  it('legacy variadic (str, str, ...) joins strings under kind:sync', () => {
    const { emit, calls } = captureEmit();
    emitSyncLog(emit, ['[sync] apply note abc update — LWW skip']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.obj, { kind: 'sync' });
    assert.equal(calls[0]?.msg, '[sync] apply note abc update — LWW skip');
  });

  it('does not stringify the object arg into msg (the regression)', () => {
    const { emit, calls } = captureEmit();
    emitSyncLog(emit, [{ attempt: 3 }, 'something happened']);
    assert.equal(calls.length, 1);
    assert.ok(!String(calls[0]?.msg ?? '').includes('[object Object]'));
    assert.equal(calls[0]?.msg, 'something happened');
  });

  it('Error first-arg falls through to string path (not merged as object)', () => {
    const { emit, calls } = captureEmit();
    const err = new Error('boom');
    emitSyncLog(emit, [err, 'fell over']);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.obj, { kind: 'sync' });
    assert.match(calls[0]?.msg ?? '', /boom/);
    assert.match(calls[0]?.msg ?? '', /fell over/);
  });

  it('array first-arg falls through to string path', () => {
    const { emit, calls } = captureEmit();
    emitSyncLog(emit, [['a', 'b'], 'tail']);
    assert.deepEqual(calls[0]?.obj, { kind: 'sync' });
  });

  it('object-only (no msg) emits obj with undefined msg', () => {
    const { emit, calls } = captureEmit();
    emitSyncLog(emit, [{ attempt: 1 }]);
    assert.deepEqual(calls[0]?.obj, { kind: 'sync', attempt: 1 });
    assert.equal(calls[0]?.msg, undefined);
  });

  it('caller-supplied kind overrides default sync', () => {
    const { emit, calls } = captureEmit();
    emitSyncLog(emit, [{ kind: 'retry', attempt: 1 }, 'msg']);
    // Last-wins spread: `{ kind: 'sync', ...obj }`, so caller's `kind`
    // takes precedence.
    assert.equal(calls[0]?.obj.kind, 'retry');
  });
});
