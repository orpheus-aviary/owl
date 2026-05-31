import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSwitchGate } from './switch-gate.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('createSwitchGate (P5-d Phase 14)', () => {
  it('isSwitching false + generation 0 initially', () => {
    const g = createSwitchGate();
    assert.equal(g.isSwitching(), false);
    assert.equal(g.generation(), 0);
  });

  it('runExclusive sets isSwitching during the body, clears after', async () => {
    const g = createSwitchGate();
    let during: boolean | null = null;
    await g.runExclusive(async () => {
      during = g.isSwitching();
    });
    assert.equal(during, true);
    assert.equal(g.isSwitching(), false);
  });

  it('runExclusive bumps generation each call (monotonic)', async () => {
    const g = createSwitchGate();
    await g.runExclusive(async () => {});
    assert.equal(g.generation(), 1);
    await g.runExclusive(async () => {});
    assert.equal(g.generation(), 2);
  });

  it('waits for in-flight mutations to drain before running the body', async () => {
    const g = createSwitchGate();
    const release = g.trackMutation(); // a mutation passed the gate, still in flight
    let bodyRan = false;
    const p = g.runExclusive(async () => {
      bodyRan = true;
    });
    await tick();
    assert.equal(bodyRan, false, 'body blocked until the mutation releases');
    release();
    await p;
    assert.equal(bodyRan, true);
  });

  it('serialises concurrent switches — no overlap', async () => {
    const g = createSwitchGate();
    const order: string[] = [];
    const a = g.runExclusive(async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('a-end');
    });
    const b = g.runExclusive(async () => {
      order.push('b-start');
      order.push('b-end');
    });
    await Promise.all([a, b]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('a rejected switch does not poison the lock for the next', async () => {
    const g = createSwitchGate();
    await assert.rejects(
      g.runExclusive(async () => {
        throw new Error('boom');
      }),
    );
    let ran = false;
    await g.runExclusive(async () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.equal(g.generation(), 2, 'both switches bumped generation');
  });

  it('trackMutation release is idempotent', async () => {
    const g = createSwitchGate();
    const release = g.trackMutation();
    release();
    release(); // second call must not underflow the counter
    let ran = false;
    await g.runExclusive(async () => {
      ran = true;
    });
    assert.equal(ran, true);
  });
});
