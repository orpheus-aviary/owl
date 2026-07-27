import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { applyForwardMigrations, readInitialSql } from '../migrate.js';

// 0010 zeroes the timestamps of PRISTINE special notes so a device's local
// materialisation stops beating the other device's real edit in LWW. Anything
// the user actually touched must keep its real timestamps — see the migration
// header for the failure it fixes.

const MEMO = '00000000-0000-0000-0000-000000000001';
const TODO = '00000000-0000-0000-0000-000000000002';
const MEMO_DEFAULT = '# 随记\n\n';
const TODO_DEFAULT = '# 待办\n\n- [ ] ';

const SEEDED_AT = 1_700_000_000_000;

interface NoteRow {
  id: string;
  content: string;
  created_at: number;
  updated_at: number;
  lww_counter: number;
}

/** A v9 database — one version below the migration under test. */
function seedV9Db(dbPath: string): BetterSqlite3.Database {
  const sqlite = new BetterSqlite3(dbPath);
  runScript(sqlite, readInitialSql());
  sqlite.pragma('user_version = 1');
  applyForwardMigrations(sqlite, 1, 9);
  sqlite
    .prepare("INSERT OR REPLACE INTO local_metadata (key, value) VALUES ('device_uuid', ?)")
    .run('dev-uuid');
  return sqlite;
}

/** Multi-statement DDL runner (better-sqlite3, not a shell). */
function runScript(sqlite: BetterSqlite3.Database, sql: string): void {
  sqlite.exec(sql);
}

function insertNote(
  sqlite: BetterSqlite3.Database,
  id: string,
  content: string,
  createdAt: number,
  updatedAt: number,
): void {
  sqlite
    .prepare(
      `INSERT INTO notes (id, content, content_hash, folder_id, trash_level,
                          created_at, updated_at, device_id, local_device_uuid, lww_counter)
         VALUES (?, ?, ?, NULL, 0, ?, ?, NULL, 'dev-uuid', 0)`,
    )
    .run(id, content, `h-${id}`, createdAt, updatedAt);
}

function insertChange(
  sqlite: BetterSqlite3.Database,
  entityId: string,
  op: string,
  payload: Record<string, unknown>,
): void {
  sqlite
    .prepare(
      `INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload,
                                 created_at, client_change_id)
         VALUES ('dev-uuid', 'note', ?, ?, ?, ?, ?)`,
    )
    .run(entityId, op, JSON.stringify(payload), SEEDED_AT, `cid-${entityId}-${op}`);
}

function readNote(sqlite: BetterSqlite3.Database, id: string): NoteRow {
  return sqlite
    .prepare('SELECT id, content, created_at, updated_at, lww_counter FROM notes WHERE id = ?')
    .get(id) as NoteRow;
}

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'owl-0010-'));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('0010_special_notes_seed_ts', () => {
  it('T1: a pristine seed is zeroed', () => {
    const sqlite = seedV9Db(join(tmp, 't1.db'));
    insertNote(sqlite, MEMO, MEMO_DEFAULT, SEEDED_AT, SEEDED_AT);
    insertNote(sqlite, TODO, TODO_DEFAULT, SEEDED_AT, SEEDED_AT);

    applyForwardMigrations(sqlite, 9, 10);

    for (const id of [MEMO, TODO]) {
      const row = readNote(sqlite, id);
      assert.equal(row.created_at, 0, `${id} created_at`);
      assert.equal(row.updated_at, 0, `${id} updated_at`);
      assert.equal(row.lww_counter, 0, `${id} lww_counter`);
    }
    sqlite.close();
  });

  it('T2: an edited note keeps its real timestamps', () => {
    const sqlite = seedV9Db(join(tmp, 't2.db'));
    insertNote(sqlite, MEMO, '# 随记\n\n买牛奶', SEEDED_AT, SEEDED_AT + 60_000);
    insertChange(sqlite, MEMO, 'update', {
      content: '# 随记\n\n买牛奶',
      updated_at_ms: SEEDED_AT + 60_000,
    });

    applyForwardMigrations(sqlite, 9, 10);

    const row = readNote(sqlite, MEMO);
    assert.equal(row.created_at, SEEDED_AT);
    assert.equal(row.updated_at, SEEDED_AT + 60_000);
    sqlite.close();
  });

  // `setNotePinned` deliberately does not touch updated_at, so a pinned-but-
  // never-edited seed is still pristine and still needs zeroing. Excluding it
  // (as a naive "any sync_changes row" filter would) leaves exactly the rows
  // the migration exists to fix.
  it('T3: pinned-only is still zeroed', () => {
    const sqlite = seedV9Db(join(tmp, 't3.db'));
    insertNote(sqlite, MEMO, MEMO_DEFAULT, SEEDED_AT, SEEDED_AT);
    insertChange(sqlite, MEMO, 'pin', { pinned_at_ms: SEEDED_AT + 5_000 });

    applyForwardMigrations(sqlite, 9, 10);

    assert.equal(readNote(sqlite, MEMO).updated_at, 0);
    sqlite.close();
  });

  // reorder emits op='update' with a `{position}`-only payload — the reason the
  // filter keys off the payload rather than the op.
  it('T4: reorder-only is still zeroed', () => {
    const sqlite = seedV9Db(join(tmp, 't4.db'));
    insertNote(sqlite, TODO, TODO_DEFAULT, SEEDED_AT, SEEDED_AT);
    insertChange(sqlite, TODO, 'update', { position: 2000 });

    applyForwardMigrations(sqlite, 9, 10);

    assert.equal(readNote(sqlite, TODO).updated_at, 0);
    sqlite.close();
  });

  it('T5: a content-bearing update row blocks zeroing even if the content matches', () => {
    const sqlite = seedV9Db(join(tmp, 't5.db'));
    // Edited then reverted to exactly the template: content alone can't tell.
    insertNote(sqlite, MEMO, MEMO_DEFAULT, SEEDED_AT, SEEDED_AT);
    insertChange(sqlite, MEMO, 'update', { content: MEMO_DEFAULT, updated_at_ms: SEEDED_AT });

    applyForwardMigrations(sqlite, 9, 10);

    assert.equal(readNote(sqlite, MEMO).updated_at, SEEDED_AT, 'left alone');
    sqlite.close();
  });

  it('T6: created_at != updated_at blocks zeroing', () => {
    const sqlite = seedV9Db(join(tmp, 't6.db'));
    insertNote(sqlite, MEMO, MEMO_DEFAULT, SEEDED_AT, SEEDED_AT + 1);

    applyForwardMigrations(sqlite, 9, 10);

    assert.equal(readNote(sqlite, MEMO).updated_at, SEEDED_AT + 1);
    sqlite.close();
  });

  it('T7: ordinary notes are untouched', () => {
    const sqlite = seedV9Db(join(tmp, 't7.db'));
    insertNote(sqlite, 'n-user', '# 随记\n\n', SEEDED_AT, SEEDED_AT);

    applyForwardMigrations(sqlite, 9, 10);

    const row = readNote(sqlite, 'n-user');
    assert.equal(row.created_at, SEEDED_AT, 'a user note with template-ish content is not special');
    sqlite.close();
  });

  it('T8: runs clean on a db with no special notes at all', () => {
    const sqlite = seedV9Db(join(tmp, 't8.db'));
    assert.doesNotThrow(() => applyForwardMigrations(sqlite, 9, 10));
    assert.equal(sqlite.pragma('user_version', { simple: true }), 10);
    sqlite.close();
  });
});
