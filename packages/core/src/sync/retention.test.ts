import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import { isSelfReplay } from './lww.js';
import { ensureRetentionWatermark, pruneSyncedChanges } from './retention.js';

const ENDPOINT = 'http://sync.example.test';
const NOW = 10_000_000;
const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 7 * DAY;
/** Comfortably outside the retention window. */
const OLD = NOW - RETENTION - DAY;

const now = (): number => NOW;

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = createDatabase({ dbPath: ':memory:' }).sqlite;
});

interface ChangeInput {
  cid: string;
  /** null = pending (never acked). */
  serverSeq?: number | null;
  syncedAt?: number | null;
}

/** Insert one outbox row; returns its local_seq. */
function seedChange(input: ChangeInput): number {
  const info = sqlite
    .prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at,
          client_change_id, server_seq, synced_at)
       VALUES ('dev-local', 'note', 'n1', 'update', '{}', 1, ?, ?, ?)`,
    )
    .run(input.cid, input.serverSeq ?? null, input.syncedAt ?? null);
  return Number(info.lastInsertRowid);
}

function seedCursor(endpoint: string, pulledSeq: number): void {
  sqlite
    .prepare(
      'INSERT INTO sync_cursor (endpoint, pulled_seq, pushed_seq, updated_at) VALUES (?, ?, 0, 1)',
    )
    .run(endpoint, pulledSeq);
}

function setWatermark(value: number): void {
  sqlite
    .prepare(
      `INSERT INTO local_metadata (key, value) VALUES ('sync_retention_safe_after_local_seq', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(String(value));
}

function remainingSeqs(): number[] {
  return (
    sqlite.prepare('SELECT local_seq FROM sync_changes ORDER BY local_seq').all() as {
      local_seq: number;
    }[]
  ).map((r) => r.local_seq);
}

/** One prunable row: acked, inside the cursor, well outside the time window. */
function seedPrunable(cid: string, serverSeq: number): number {
  return seedChange({ cid, serverSeq, syncedAt: OLD });
}

describe('retention — ensureRetentionWatermark', () => {
  it('a never-synced db starts at 0', () => {
    seedChange({ cid: 'c1', serverSeq: 1, syncedAt: OLD });
    assert.equal(ensureRetentionWatermark(sqlite), 0);
  });

  it('a db that already synced freezes everything that exists today', () => {
    seedChange({ cid: 'c1', serverSeq: 1, syncedAt: OLD });
    const last = seedChange({ cid: 'c2', serverSeq: 2, syncedAt: OLD });
    seedCursor(ENDPOINT, 5);
    assert.equal(ensureRetentionWatermark(sqlite), last);
  });

  it('is idempotent — a later call never moves the watermark', () => {
    seedCursor(ENDPOINT, 5);
    const first = ensureRetentionWatermark(sqlite);
    seedChange({ cid: 'c-new', serverSeq: 9, syncedAt: OLD });
    assert.equal(ensureRetentionWatermark(sqlite), first);
  });
});

describe('retention — pruneSyncedChanges gates', () => {
  it('watermark_initialized: the establishing round deletes nothing', () => {
    seedCursor(ENDPOINT, 100);
    // A pre-0.6.2 db reaching prune before any session install.
    seedPrunable('c1', 1);

    const result = pruneSyncedChanges(sqlite, { endpoint: ENDPOINT, nowMs: now });

    assert.deepEqual(result, { pruned: false, reason: 'watermark_initialized' });
    assert.equal(remainingSeqs().length, 1);
  });

  it('no_cursor: never synced through this endpoint', () => {
    setWatermark(0);
    seedPrunable('c1', 1);

    const result = pruneSyncedChanges(sqlite, { endpoint: ENDPOINT, nowMs: now });

    assert.deepEqual(result, { pruned: false, reason: 'no_cursor' });
    assert.equal(remainingSeqs().length, 1);
  });

  it('multi_endpoint: two cursor rows mean two seq spaces', () => {
    setWatermark(0);
    seedCursor(ENDPOINT, 100);
    seedCursor('http://other.example.test', 50);
    seedPrunable('c1', 1);

    const result = pruneSyncedChanges(sqlite, { endpoint: ENDPOINT, nowMs: now });

    assert.deepEqual(result, { pruned: false, reason: 'multi_endpoint' });
    assert.equal(remainingSeqs().length, 1);
  });

  it('endpoint_mismatch: the only cursor belongs to another server', () => {
    setWatermark(0);
    seedCursor('http://other.example.test', 100);
    seedPrunable('c1', 1);

    const result = pruneSyncedChanges(sqlite, { endpoint: ENDPOINT, nowMs: now });

    assert.deepEqual(result, { pruned: false, reason: 'endpoint_mismatch' });
    assert.equal(remainingSeqs().length, 1);
  });
});

describe('retention — pruneSyncedChanges row selection', () => {
  it('deletes only rows above the provenance watermark', () => {
    const belowA = seedPrunable('c-below-a', 1);
    const belowB = seedPrunable('c-below-b', 2);
    const above = seedPrunable('c-above', 3);
    setWatermark(belowB);
    seedCursor(ENDPOINT, 100);

    const result = pruneSyncedChanges(sqlite, { endpoint: ENDPOINT, nowMs: now });

    assert.equal(result.pruned && result.deleted, 1);
    assert.deepEqual(remainingSeqs(), [belowA, belowB]);
    assert.ok(!remainingSeqs().includes(above));
  });

  it('never deletes a pending row, however old', () => {
    setWatermark(0);
    seedCursor(ENDPOINT, 100);
    const pending = seedChange({ cid: 'c-pending', serverSeq: null, syncedAt: null });
    // A row acked long ago but with no server_seq can't be proven undeliverable.
    const noSeq = seedChange({ cid: 'c-noseq', serverSeq: null, syncedAt: OLD });
    seedPrunable('c-ok', 1);

    const result = pruneSyncedChanges(sqlite, { endpoint: ENDPOINT, nowMs: now });

    assert.equal(result.pruned && result.deleted, 1);
    assert.deepEqual(remainingSeqs(), [pending, noSeq]);
  });

  it('never deletes a row the cursor has not passed yet', () => {
    setWatermark(0);
    seedCursor(ENDPOINT, 5);
    const ahead = seedPrunable('c-ahead', 6);
    seedPrunable('c-behind', 5);

    const result = pruneSyncedChanges(sqlite, { endpoint: ENDPOINT, nowMs: now });

    assert.equal(result.pruned && result.deleted, 1);
    assert.deepEqual(remainingSeqs(), [ahead]);
  });

  it('never deletes a row inside the time window', () => {
    setWatermark(0);
    seedCursor(ENDPOINT, 100);
    const fresh = seedChange({ cid: 'c-fresh', serverSeq: 1, syncedAt: NOW - DAY });
    seedPrunable('c-old', 2);

    const result = pruneSyncedChanges(sqlite, { endpoint: ENDPOINT, nowMs: now });

    assert.equal(result.pruned && result.deleted, 1);
    assert.deepEqual(remainingSeqs(), [fresh]);
  });

  it('honours maxRows and deletes oldest-first', () => {
    setWatermark(0);
    seedCursor(ENDPOINT, 100);
    const seqs = [1, 2, 3, 4].map((i) => seedPrunable(`c${i}`, i));

    const result = pruneSyncedChanges(sqlite, { endpoint: ENDPOINT, nowMs: now, maxRows: 2 });

    assert.equal(result.pruned && result.deleted, 2);
    assert.deepEqual(remainingSeqs(), [seqs[2], seqs[3]]);
  });

  it('keeps isSelfReplay working for rows still inside the window', () => {
    setWatermark(0);
    seedCursor(ENDPOINT, 100);
    seedPrunable('cid-old', 1);
    seedChange({ cid: 'cid-recent', serverSeq: 2, syncedAt: NOW - DAY });

    pruneSyncedChanges(sqlite, { endpoint: ENDPOINT, nowMs: now });

    assert.equal(isSelfReplay(sqlite, 'cid-recent'), true);
    assert.equal(isSelfReplay(sqlite, 'cid-old'), false, 'pruned row is no longer recognised');
  });

  it('a custom retentionMs shifts the cutoff', () => {
    setWatermark(0);
    seedCursor(ENDPOINT, 100);
    seedChange({ cid: 'c-2d', serverSeq: 1, syncedAt: NOW - 2 * DAY });

    const result = pruneSyncedChanges(sqlite, {
      endpoint: ENDPOINT,
      nowMs: now,
      retentionMs: DAY,
    });

    assert.equal(result.pruned && result.deleted, 1);
    assert.deepEqual(remainingSeqs(), []);
  });
});
