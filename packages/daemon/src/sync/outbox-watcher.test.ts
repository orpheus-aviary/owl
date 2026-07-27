/**
 * Problem A / Phase 1 — outbox watcher.
 *
 * Drives a real sqlite db (so the pending probe runs against the real schema
 * and its partial index) with an injected clock and a stubbed sync round.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type Logger,
  createDatabase,
  emitSyncChange,
  ensureDeviceId,
} from '@owl/core';
import type Database from 'better-sqlite3';
import type { AppContext } from '../context.js';
import { createOutboxWatcher } from './outbox-watcher.js';
import { createSwitchGate } from './switch-gate.js';

function silentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

let tmp: string;
let sqlite: Database.Database;
let ctx: AppContext;
/** Injected clock, in ms. Tests advance it explicitly. */
let clock: number;

function makeCtx(): AppContext {
  const db = createDatabase({ dbPath: join(tmp, 'owl.db') });
  sqlite = db.sqlite;
  ensureDeviceId(db.db);
  return {
    db: db.db,
    sqlite: db.sqlite,
    config: structuredClone(DEFAULT_CONFIG),
    logger: silentLogger(),
    // A non-null session is all `syncTriggerReady` looks at.
    skybridgeSession: { workspaceId: 'ws-1' },
    switchGate: createSwitchGate(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub for the watcher
  } as any;
}

function addPendingChange(entityId: string): void {
  sqlite.transaction(() => {
    emitSyncChange(sqlite, {
      entityType: 'note',
      entityId,
      op: 'update',
      payload: { updated_at_ms: clock },
    });
  })();
}

function markAllSynced(): void {
  sqlite.prepare('UPDATE sync_changes SET synced_at = ?, server_seq = 1').run(clock);
}

interface Harness {
  calls: number;
  resolveRound: (() => void) | null;
  rejectRound: ((err: Error) => void) | null;
}

/**
 * Watcher with a manually-settled round, so a test can hold one "in flight"
 * and observe what the poll loop does meanwhile.
 */
function startWatcher(opts: { autoSettle?: 'resolve' | 'reject' | 'manual' } = {}): {
  handle: ReturnType<typeof createOutboxWatcher>;
  h: Harness;
} {
  const mode = opts.autoSettle ?? 'resolve';
  const h: Harness = { calls: 0, resolveRound: null, rejectRound: null };
  const handle = createOutboxWatcher({
    ctx,
    logger: silentLogger(),
    now: () => clock,
    random: () => 0.5, // no jitter offset
    // The watcher's own interval never fires; tests call tickNow().
    setInterval: (() => ({ unref() {} })) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => {}) as unknown as typeof globalThis.clearInterval,
    runSync: () => {
      h.calls += 1;
      if (mode === 'resolve') return Promise.resolve({});
      if (mode === 'reject') return Promise.reject(new Error('push failed'));
      return new Promise((resolve, reject) => {
        h.resolveRound = () => resolve({});
        h.rejectRound = reject;
      });
    },
  });
  return { handle, h };
}

/** Let queued microtasks (the round's .then/.catch/.finally) run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'owl-outbox-watcher-'));
  clock = 1_000_000;
  ctx = makeCtx();
});

afterEach(() => {
  sqlite.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('createOutboxWatcher (Problem A / Phase 1)', () => {
  it('stays quiet while the outbox is clean', () => {
    const { handle, h } = startWatcher();
    handle.tickNow();
    clock += 10_000;
    handle.tickNow();
    assert.equal(h.calls, 0);
    handle.stop();
  });

  it('debounces: fires only after the outbox stops growing', async () => {
    const { handle, h } = startWatcher();

    addPendingChange('n1');
    handle.tickNow(); // first sighting — anchors the quiet window
    assert.equal(h.calls, 0, 'no immediate fire');

    clock += 500; // still inside QUIET_MS
    handle.tickNow();
    assert.equal(h.calls, 0);

    clock += 500; // 1000ms since the last change → settled
    handle.tickNow();
    await settle();
    assert.equal(h.calls, 1);
    handle.stop();
  });

  it('a fresh change re-anchors the quiet window', () => {
    const { handle, h } = startWatcher();

    addPendingChange('n1');
    handle.tickNow();
    clock += 700;
    addPendingChange('n2'); // still typing
    handle.tickNow();
    clock += 700; // 700ms since the LAST change — not settled yet
    handle.tickNow();
    assert.equal(h.calls, 0, 'quiet window restarted by the new row');
    handle.stop();
  });

  it('maxWait fires despite continuous writes (no starvation)', async () => {
    const { handle, h } = startWatcher();

    addPendingChange('n0');
    handle.tickNow();
    // Keep writing every 600ms so the quiet window never elapses.
    for (let i = 0; i < 9; i++) {
      clock += 600;
      addPendingChange(`n${i + 1}`);
      handle.tickNow();
    }
    await settle();
    assert.equal(h.calls, 1, 'MAX_WAIT_MS forced a round');
    handle.stop();
  });

  it('does not start a second round while its own round is in flight', async () => {
    const { handle, h } = startWatcher({ autoSettle: 'manual' });

    addPendingChange('n1');
    handle.tickNow();
    clock += 1_000;
    handle.tickNow(); // starts the round
    await settle();
    assert.equal(h.calls, 1);

    // More edits land, and many poll cycles pass, while the round hangs.
    addPendingChange('n2');
    for (let i = 0; i < 5; i++) {
      clock += 1_000;
      handle.tickNow();
    }
    assert.equal(h.calls, 1, 'singleflight held');

    h.resolveRound?.();
    await settle();
    handle.stop();
  });

  // The sync coalescer runs a queued follow-up even when the in-flight round
  // rejected, so polling into it after a failure would re-push immediately and
  // step over the backoff. The watcher must hold the line itself.
  it('after a failed round, makes no further calls until the backoff expires', async () => {
    const { handle, h } = startWatcher({ autoSettle: 'reject' });

    addPendingChange('n1');
    handle.tickNow();
    clock += 1_000;
    handle.tickNow();
    await settle();
    assert.equal(h.calls, 1, 'first attempt ran');

    // BACKOFF_MS[0] = 2000ms (jitter pinned off), so the retry is due exactly
    // two polls later. The poll in between must not call through.
    clock += 1_000;
    handle.tickNow();
    await settle();
    assert.equal(h.calls, 1, 'no retry inside the backoff window');

    clock += 1_000; // now at nextAttemptAt
    handle.tickNow();
    await settle();
    assert.equal(h.calls, 2, 'retried once the backoff expired');
    handle.stop();
  });

  it('resets the backoff after a success', async () => {
    let fail = true;
    const calls: number[] = [];
    const handle = createOutboxWatcher({
      ctx,
      logger: silentLogger(),
      now: () => clock,
      random: () => 0.5,
      setInterval: (() => ({ unref() {} })) as unknown as typeof globalThis.setInterval,
      clearInterval: (() => {}) as unknown as typeof globalThis.clearInterval,
      runSync: () => {
        calls.push(clock);
        if (fail) return Promise.reject(new Error('push failed'));
        markAllSynced();
        return Promise.resolve({});
      },
    });

    addPendingChange('n1');
    handle.tickNow();
    clock += 1_000;
    handle.tickNow();
    await settle();
    assert.equal(calls.length, 1);

    fail = false;
    clock += 3_000; // past the 2s backoff
    handle.tickNow();
    await settle();
    assert.equal(calls.length, 2, 'retry ran and succeeded');

    // A new edit after a success must fire on the normal debounce, not a backoff.
    addPendingChange('n2');
    handle.tickNow();
    clock += 1_000;
    handle.tickNow();
    await settle();
    assert.equal(calls.length, 3, 'backoff was reset by the success');
    handle.stop();
  });

  it('holds off entirely when no sync session is installed', () => {
    ctx.skybridgeSession = null;
    const { handle, h } = startWatcher();

    addPendingChange('n1');
    handle.tickNow();
    clock += 5_000;
    handle.tickNow();
    assert.equal(h.calls, 0, 'no round attempted without a session');
    handle.stop();
  });

  it('skips ticks while a profile switch is in flight', async () => {
    const { handle, h } = startWatcher();
    addPendingChange('n1');
    handle.tickNow();
    clock += 5_000;

    const gate = ctx.switchGate;
    assert.ok(gate);
    // Hold the gate open: `runExclusive` only flips `switching` once its body
    // starts, so wait for that before asserting.
    let release!: () => void;
    const switchStarted = new Promise<void>((started) => {
      void gate.runExclusive(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
            started();
          }),
      );
    });
    await switchStarted;

    handle.tickNow();
    assert.equal(h.calls, 0, 'no sync while the db is being swapped');
    release();
    await settle();
    handle.stop();
  });

  it('discards a round whose profile was switched out mid-flight', async () => {
    const { handle, h } = startWatcher({ autoSettle: 'manual' });
    addPendingChange('n1');
    handle.tickNow();
    clock += 1_000;
    handle.tickNow(); // round starts under generation 0
    await settle();
    assert.equal(h.calls, 1);

    // A switch happens and completes while the round is still running.
    const gate = ctx.switchGate;
    assert.ok(gate);
    await gate.runExclusive(async () => {});

    h.rejectRound?.(new Error('failed against the old db'));
    await settle();

    // The failure belonged to the previous profile: no backoff should have been
    // recorded, so the very next settled window fires immediately.
    clock += 1_000;
    handle.tickNow();
    await settle();
    assert.equal(h.calls, 2, 'stale failure did not arm a backoff');
    handle.stop();
  });

  it('stop() is idempotent and prevents further ticks', async () => {
    const { handle, h } = startWatcher();
    addPendingChange('n1');
    handle.tickNow();
    clock += 1_000;
    handle.stop();
    handle.stop();
    handle.tickNow();
    await settle();
    assert.equal(h.calls, 0);
  });

  // The per-tick probe is only cheap because SQLite serves it from the 0005
  // partial index (local_seq is the rowid = that index's implicit trailing
  // column, so MIN/MAX seeks the end instead of walking every pending row).
  // If a future schema change breaks that, the watcher silently becomes an
  // O(pending) scan every second — hence this guard.
  it('the pending probe is served by the partial index, not a table scan', () => {
    addPendingChange('n1');
    const plan = sqlite
      .prepare('EXPLAIN QUERY PLAN SELECT MAX(local_seq) FROM sync_changes WHERE synced_at IS NULL')
      .all() as { detail: string }[];
    const detail = plan.map((r) => r.detail).join(' | ');
    assert.match(
      detail,
      /idx_sync_changes_pending/,
      `expected the partial index to serve the probe, got: ${detail}`,
    );
    assert.doesNotMatch(detail, /SCAN sync_changes/, `probe degraded to a scan: ${detail}`);
  });
});
