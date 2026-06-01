/**
 * W3 (Phase 16c) — HLC-lite unit suite.
 *
 * Covers the pure stamp/observe/offset helpers (deterministic via injected
 * clock) plus the business-write integration that they're called from.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import type { OwlDatabase } from '../db/index.js';
import { createFolder } from '../folders/index.js';
import { createNote, updateNote } from '../notes/index.js';
import {
  observeRemoteLwwKey,
  readServerTimeOffset,
  serverNormalizedStamp,
  setServerTimeOffset,
} from './hlc.js';

let sqlite: Database.Database;
// biome-ignore lint/suspicious/noExplicitAny: drizzle wrapper type irrelevant to tests
let db: any;

before(() => {
  const result = createDatabase({ dbPath: ':memory:' });
  sqlite = result.sqlite;
  db = result.db as OwlDatabase;
});

after(() => {
  sqlite.close();
});

beforeEach(() => {
  sqlite.prepare('DELETE FROM local_metadata').run();
  sqlite.prepare('DELETE FROM sync_changes').run();
  sqlite.prepare('DELETE FROM notes').run();
  sqlite.prepare('DELETE FROM folders').run();
});

// ─── serverNormalizedStamp ───────────────────────────────────────────

describe('serverNormalizedStamp', () => {
  it('same physical ms → counter increments 0, 1, 2', () => {
    const clock = () => 1_000;
    assert.deepEqual(serverNormalizedStamp(sqlite, clock), { ms: 1_000, counter: 0 });
    assert.deepEqual(serverNormalizedStamp(sqlite, clock), { ms: 1_000, counter: 1 });
    assert.deepEqual(serverNormalizedStamp(sqlite, clock), { ms: 1_000, counter: 2 });
  });

  it('physical clock advances → counter resets to 0', () => {
    assert.deepEqual(
      serverNormalizedStamp(sqlite, () => 1_000),
      { ms: 1_000, counter: 0 },
    );
    assert.deepEqual(
      serverNormalizedStamp(sqlite, () => 1_000),
      { ms: 1_000, counter: 1 },
    );
    assert.deepEqual(
      serverNormalizedStamp(sqlite, () => 2_000),
      { ms: 2_000, counter: 0 },
    );
  });

  it('offset re-bases ms onto the server clock — a fast local clock no longer wins', () => {
    // errclock black hole fix: a device running 500ms ahead gets normalized
    // down by the offset, so its stamp can't dominate a correct peer's.
    setServerTimeOffset(sqlite, -500);
    assert.deepEqual(
      serverNormalizedStamp(sqlite, () => 10_000),
      { ms: 9_500, counter: 0 },
    );
  });

  it('a backwards offset jump stays monotone via the counter', () => {
    setServerTimeOffset(sqlite, 0);
    assert.deepEqual(
      serverNormalizedStamp(sqlite, () => 5_000),
      { ms: 5_000, counter: 0 },
    );
    // server clock corrected backwards by 2s → phys 3000 < last 5000
    setServerTimeOffset(sqlite, -2_000);
    assert.deepEqual(
      serverNormalizedStamp(sqlite, () => 5_000),
      { ms: 5_000, counter: 1 },
    );
  });
});

// ─── observeRemoteLwwKey ─────────────────────────────────────────────

describe('observeRemoteLwwKey', () => {
  it('advances HLC so the next local stamp outranks the observed remote', () => {
    observeRemoteLwwKey(sqlite, { ms: 8_000, counter: 5 });
    // local physical clock is behind the observed remote ms
    assert.deepEqual(
      serverNormalizedStamp(sqlite, () => 1_000),
      { ms: 8_000, counter: 6 },
    );
  });

  it('same ms with a higher remote counter bumps the counter only', () => {
    serverNormalizedStamp(sqlite, () => 4_000); // {4000, 0}
    observeRemoteLwwKey(sqlite, { ms: 4_000, counter: 9 });
    assert.deepEqual(
      serverNormalizedStamp(sqlite, () => 4_000),
      { ms: 4_000, counter: 10 },
    );
  });

  it('a strictly older remote does not move local HLC', () => {
    serverNormalizedStamp(sqlite, () => 7_000); // {7000, 0}
    observeRemoteLwwKey(sqlite, { ms: 3_000, counter: 99 });
    assert.deepEqual(
      serverNormalizedStamp(sqlite, () => 7_000),
      { ms: 7_000, counter: 1 },
    );
  });
});

// ─── offset accessors ────────────────────────────────────────────────

describe('setServerTimeOffset / readServerTimeOffset', () => {
  it('round-trips (incl. negative) and defaults to 0', () => {
    assert.equal(readServerTimeOffset(sqlite), 0);
    setServerTimeOffset(sqlite, 1234);
    assert.equal(readServerTimeOffset(sqlite), 1234);
    setServerTimeOffset(sqlite, -77);
    assert.equal(readServerTimeOffset(sqlite), -77);
  });
});

// ─── business-write integration ──────────────────────────────────────

function noteCounter(id: string): { ms: number; counter: number } {
  const row = sqlite.prepare('SELECT updated_at, lww_counter FROM notes WHERE id = ?').get(id) as {
    updated_at: number;
    lww_counter: number;
  };
  return { ms: row.updated_at, counter: row.lww_counter };
}

function lastPayload(id: string, op: string): Record<string, unknown> {
  const row = sqlite
    .prepare(
      'SELECT payload FROM sync_changes WHERE entity_id = ? AND op = ? ORDER BY local_seq DESC LIMIT 1',
    )
    .get(id, op) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

describe('business writes stamp lww_counter', () => {
  it('createNote writes lww_counter on the row and the payload (fresh db → 0)', () => {
    const note = createNote(db, sqlite, { content: 'hi' });
    assert.equal(noteCounter(note.id).counter, 0);
    const payload = lastPayload(note.id, 'create');
    assert.equal(payload.lww_counter, 0);
    // create stamps created == updated with the same normalized ms
    assert.equal(payload.created_at_ms, payload.updated_at_ms);
  });

  it('createFolder writes lww_counter on the row and the payload', () => {
    const folder = createFolder(db, sqlite, { name: 'F' });
    const row = sqlite.prepare('SELECT lww_counter FROM folders WHERE id = ?').get(folder.id) as {
      lww_counter: number;
    };
    assert.equal(row.lww_counter, 0);
    assert.equal(lastPayload(folder.id, 'create').lww_counter, 0);
  });

  it('two writes to one note in the same physical ms get strictly increasing counters', () => {
    // Pin hlc_last_ms into the far future so every stamp takes the
    // counter-bump branch regardless of the real wall clock — deterministic.
    sqlite
      .prepare("INSERT INTO local_metadata (key, value) VALUES ('hlc_last_ms', ?)")
      .run(String(10_000_000_000_000));
    sqlite
      .prepare("INSERT INTO local_metadata (key, value) VALUES ('hlc_last_counter', '0')")
      .run();

    const note = createNote(db, sqlite, { content: 'a' });
    const first = noteCounter(note.id);
    updateNote(db, sqlite, note.id, { content: 'b' });
    const second = noteCounter(note.id);

    assert.equal(first.ms, second.ms, 'same logical ms');
    assert.ok(
      second.counter > first.counter,
      `counter advanced ${first.counter} → ${second.counter}`,
    );
    assert.equal(lastPayload(note.id, 'update').lww_counter, second.counter);
  });
});
