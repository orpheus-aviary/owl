/**
 * Coalescer behaviour spec — every caller's Promise must resolve from a
 * round that began *after* the caller's call returned, so any local commit
 * made before calling is visible to that round's read.
 *
 * See `coalesce.ts` for the design rationale (P5-a follow-up F3).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCoalescer } from './coalesce.js';

interface Gate {
  promise: Promise<unknown>;
  release(): void;
  fail(err: unknown): void;
}

function gate(): Gate {
  let release!: () => void;
  let fail!: (err: unknown) => void;
  const promise = new Promise<unknown>((resolve, reject) => {
    release = () => resolve(undefined);
    fail = (err) => reject(err);
  });
  return { promise, release, fail };
}

/** Yield to the microtask queue enough times for any chained .then callbacks to settle. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe('createCoalescer', () => {
  it('single caller: runs the round once and returns its result', async () => {
    let calls = 0;
    const c = createCoalescer<number>(async () => {
      calls += 1;
      return 42;
    });
    const r = await c.run();
    assert.equal(r, 42);
    assert.equal(calls, 1);
  });

  it('second caller during inflight gets a SECOND round, not the first one', async () => {
    // The bug: when caller B arrives while A is running, returning A's
    // Promise means B sees A's outbox read — but A may have read before
    // B's commit landed. The fix: B gets a fresh follow-up round.
    let calls = 0;
    const gates: Gate[] = [];
    const c = createCoalescer<number>(async () => {
      const idx = calls;
      calls += 1;
      const g = gate();
      gates.push(g);
      await g.promise;
      return idx; // resolve with this round's index
    });

    const a = c.run(); // starts round 0
    const b = c.run(); // arrives during round 0 — schedules round 1

    gates[0]!.release();
    const aResult = await a;
    assert.equal(aResult, 0);

    await drainMicrotasks();
    assert.equal(gates.length, 2, 'follow-up round should have started');

    gates[1]!.release();
    const bResult = await b;
    assert.equal(bResult, 1);
    assert.equal(calls, 2);
  });

  it('three concurrent callers during one inflight round coalesce to ONE follow-up', async () => {
    let calls = 0;
    const gates: Gate[] = [];
    const c = createCoalescer<number>(async () => {
      const idx = calls;
      calls += 1;
      const g = gate();
      gates.push(g);
      await g.promise;
      return idx;
    });

    const a = c.run();
    const b = c.run();
    const cP = c.run();
    const d = c.run();

    gates[0]!.release();
    await a;
    await drainMicrotasks();
    gates[1]!.release();

    const [br, cr, dr] = await Promise.all([b, cP, d]);
    assert.equal(br, 1);
    assert.equal(cr, 1, 'second and third followers share the follow-up');
    assert.equal(dr, 1, 'third follower shares the same follow-up');
    assert.equal(calls, 2);
  });

  it('inflight rejection still lets the follow-up run with a fresh round', async () => {
    // Follower must not inherit the inflight failure — the chain join is
    // a "ran after the inflight finished" signal, not a value pipe.
    let calls = 0;
    const gates: Gate[] = [];
    const c = createCoalescer<number>(async () => {
      const idx = calls;
      calls += 1;
      const g = gate();
      gates.push(g);
      await g.promise;
      return idx;
    });

    const a = c.run();
    const b = c.run();

    gates[0]!.fail(new Error('inflight boom'));
    await assert.rejects(a, /inflight boom/);
    await drainMicrotasks();
    assert.equal(gates.length, 2, 'follow-up still scheduled after failure');
    gates[1]!.release();
    const br = await b;
    assert.equal(br, 1);
    assert.equal(calls, 2);
  });

  it('after both slots drain, the next caller starts a fresh round', async () => {
    let calls = 0;
    const c = createCoalescer<number>(async () => {
      calls += 1;
      return calls - 1;
    });
    await c.run();
    await c.run();
    assert.equal(calls, 2);
  });

  it('reset() clears both slots so the next call starts a fresh round', async () => {
    let calls = 0;
    const c = createCoalescer<number>(async () => {
      calls += 1;
      return calls - 1;
    });
    await c.run();
    c.reset();
    await c.run();
    assert.equal(calls, 2);
  });
});
