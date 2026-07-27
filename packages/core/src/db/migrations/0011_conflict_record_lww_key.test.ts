import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { applyForwardMigrations, readInitialSql } from '../migrate.js';

// 0011 widens conflict_record from two bare `updated_at_ms` columns to the full
// LWW three-tuple. Pure additive ALTER: existing rows must survive untouched
// with the four new columns NULL (that's how the GUI recognises a legacy row).

interface ConflictRow {
  id: string;
  entity_id: string;
  local_updated_at_ms: number | null;
  remote_updated_at_ms: number | null;
  local_lww_counter: number | null;
  remote_lww_counter: number | null;
  local_device_id: string | null;
  remote_device_id: string | null;
}

/** A v10 database — one version below the migration under test. */
function seedV10Db(dbPath: string): BetterSqlite3.Database {
  const sqlite = new BetterSqlite3(dbPath);
  sqlite.exec(readInitialSql());
  sqlite.pragma('user_version = 1');
  applyForwardMigrations(sqlite, 1, 10);
  return sqlite;
}

function insertLegacyConflict(sqlite: BetterSqlite3.Database, id: string): void {
  sqlite
    .prepare(
      `INSERT INTO conflict_record
         (id, entity_type, entity_id, local_seq, remote_seq, detected_at,
          resolved_at, resolution, losing_side, local_payload, remote_payload,
          local_updated_at_ms, remote_updated_at_ms)
       VALUES (?, 'note', ?, 7, 9, 1000, NULL, NULL, 'local', ?, ?, 100, 200)`,
    )
    .run(
      id,
      `note-${id}`,
      JSON.stringify({ content: 'mine' }),
      JSON.stringify({ content: 'yours' }),
    );
}

function readConflict(sqlite: BetterSqlite3.Database, id: string): ConflictRow {
  return sqlite.prepare('SELECT * FROM conflict_record WHERE id = ?').get(id) as ConflictRow;
}

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'owl-0011-'));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('0011_conflict_record_lww_key', () => {
  it('T1: the four LWW columns exist after the migration', () => {
    const sqlite = seedV10Db(join(tmp, 't1.db'));

    applyForwardMigrations(sqlite, 10, 11);

    const cols = (
      sqlite.prepare('PRAGMA table_info(conflict_record)').all() as { name: string }[]
    ).map((c) => c.name);
    for (const col of [
      'local_lww_counter',
      'remote_lww_counter',
      'local_device_id',
      'remote_device_id',
    ]) {
      assert.ok(cols.includes(col), `missing column ${col}`);
    }
    assert.equal(sqlite.pragma('user_version', { simple: true }), 11);
    sqlite.close();
  });

  it('T2: pre-existing rows keep every old value and get NULL for the new ones', () => {
    const sqlite = seedV10Db(join(tmp, 't2.db'));
    insertLegacyConflict(sqlite, 'c1');
    const before = readConflict(sqlite, 'c1');

    applyForwardMigrations(sqlite, 10, 11);

    const after = readConflict(sqlite, 'c1');
    // Zero diff on every column that existed at v10.
    for (const [key, value] of Object.entries(before)) {
      assert.deepEqual(after[key as keyof ConflictRow], value, `column ${key} changed`);
    }
    assert.equal(after.local_lww_counter, null);
    assert.equal(after.remote_lww_counter, null);
    assert.equal(after.local_device_id, null);
    assert.equal(after.remote_device_id, null);
    sqlite.close();
  });
});
