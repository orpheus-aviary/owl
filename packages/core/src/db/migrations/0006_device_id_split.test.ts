import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { applyForwardMigrations, readInitialSql } from '../migrate.js';

/**
 * Build a db stamped at user_version=5 by replaying 0001 + 0002-0005, then
 * seed some data so we can assert that 0006 doesn't disturb related rows.
 */
function seedV5Db(dbPath: string): {
  noteId: string;
  folderId: string;
  tagId: string;
  preLocalUuid: string;
} {
  const sqlite = new BetterSqlite3(dbPath);
  sqlite.exec(readInitialSql());
  sqlite.pragma('user_version = 1');
  applyForwardMigrations(sqlite, 1, 5);

  const localUuid = '11111111-1111-1111-1111-111111111111';
  sqlite
    .prepare('INSERT INTO local_metadata(key, value) VALUES (?, ?)')
    .run('device_uuid', localUuid);

  const folderId = 'folder-aaaa';
  const noteId = 'note-bbbb';
  const tagId = 'tag-cccc';
  const now = Date.now();

  sqlite
    .prepare(
      `INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, device_id)
       VALUES (?, ?, NULL, 0, ?, ?, ?)`,
    )
    .run(folderId, 'fixture', now, now, localUuid);

  sqlite
    .prepare(
      `INSERT INTO notes (id, folder_id, trash_level, created_at, updated_at,
                          trashed_at, auto_delete_at, device_id, content_hash, content, pinned_at, position)
       VALUES (?, ?, 0, ?, ?, NULL, NULL, ?, NULL, ?, NULL, NULL)`,
    )
    .run(noteId, folderId, now, now, localUuid, 'hello #demo');

  sqlite
    .prepare('INSERT INTO tags (id, tag_type, tag_value) VALUES (?, ?, ?)')
    .run(tagId, '#', 'demo');
  sqlite.prepare('INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)').run(noteId, tagId);
  sqlite
    .prepare(
      `INSERT INTO reminder_status (note_id, tag_id, fire_at, status, fired_at)
       VALUES (?, ?, ?, 'pending', NULL)`,
    )
    .run(noteId, tagId, now + 60_000);

  // P4 Phase 2: emit some sync_changes so we can assert 0006 doesn't touch them.
  sqlite
    .prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at, client_change_id)
       VALUES (?, 'note', ?, 'create', '{}', ?, ?)`,
    )
    .run(localUuid, noteId, now, 'cid-demo-1');

  // Seed FTS so we can verify the trigger chain survives the migration.
  sqlite
    .prepare(
      'INSERT INTO notes_fts(rowid, content, tags_text) VALUES ((SELECT rowid FROM notes WHERE id = ?), ?, ?)',
    )
    .run(noteId, 'hello #demo', 'demo');

  sqlite.close();
  return { noteId, folderId, tagId, preLocalUuid: localUuid };
}

describe('0006_device_id_split', () => {
  let tmp: string;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owl-0006-'));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('S1: ADD COLUMN local_device_uuid appears on notes + folders', () => {
    const dbPath = join(tmp, 's1.db');
    seedV5Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 5, 6);

    const notesCols = sqlite.pragma('table_info(notes)') as Array<{ name: string }>;
    const foldersCols = sqlite.pragma('table_info(folders)') as Array<{ name: string }>;
    assert.ok(notesCols.some((c) => c.name === 'local_device_uuid'));
    assert.ok(foldersCols.some((c) => c.name === 'local_device_uuid'));
    assert.equal(sqlite.pragma('user_version', { simple: true }) as number, 6);
    sqlite.close();
  });

  it('S2: backfill copies local_metadata.device_uuid into existing rows', () => {
    const dbPath = join(tmp, 's2.db');
    const { noteId, folderId, preLocalUuid } = seedV5Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 5, 6);

    const noteRow = sqlite
      .prepare('SELECT local_device_uuid FROM notes WHERE id = ?')
      .get(noteId) as { local_device_uuid: string };
    const folderRow = sqlite
      .prepare('SELECT local_device_uuid FROM folders WHERE id = ?')
      .get(folderId) as { local_device_uuid: string };
    assert.equal(noteRow.local_device_uuid, preLocalUuid);
    assert.equal(folderRow.local_device_uuid, preLocalUuid);
    sqlite.close();
  });

  it('S3: INSERT without local_device_uuid is rejected', () => {
    const dbPath = join(tmp, 's3.db');
    seedV5Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 5, 6);

    const now = Date.now();
    assert.throws(
      () =>
        sqlite
          .prepare(
            `INSERT INTO notes (id, folder_id, trash_level, created_at, updated_at,
                                content, local_device_uuid)
             VALUES ('note-z', NULL, 0, ?, ?, 'x', NULL)`,
          )
          .run(now, now),
      /local_device_uuid must not be null/,
    );
    assert.throws(
      () =>
        sqlite
          .prepare(
            `INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, local_device_uuid)
             VALUES ('folder-z', 'x', NULL, 0, ?, ?, NULL)`,
          )
          .run(now, now),
      /local_device_uuid must not be null/,
    );
    sqlite.close();
  });

  it('S4: UPDATE that sets local_device_uuid back to NULL is rejected', () => {
    const dbPath = join(tmp, 's4.db');
    const { noteId, folderId } = seedV5Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 5, 6);

    assert.throws(
      () => sqlite.prepare('UPDATE notes SET local_device_uuid = NULL WHERE id = ?').run(noteId),
      /local_device_uuid must not be set to null/,
    );
    assert.throws(
      () =>
        sqlite.prepare('UPDATE folders SET local_device_uuid = NULL WHERE id = ?').run(folderId),
      /local_device_uuid must not be set to null/,
    );
    // Updates that don't touch local_device_uuid must still work.
    sqlite.prepare('UPDATE notes SET content = ? WHERE id = ?').run('changed', noteId);
    sqlite.close();
  });

  it('S5: note_tags and reminder_status row counts are preserved (cascade regression)', () => {
    const dbPath = join(tmp, 's5.db');
    seedV5Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    const beforeTagsRow = sqlite.prepare('SELECT count(*) AS n FROM note_tags').get() as {
      n: number;
    };
    const beforeAlarmsRow = sqlite.prepare('SELECT count(*) AS n FROM reminder_status').get() as {
      n: number;
    };
    assert.ok(beforeTagsRow.n > 0);
    assert.ok(beforeAlarmsRow.n > 0);

    applyForwardMigrations(sqlite, 5, 6);

    const afterTagsRow = sqlite.prepare('SELECT count(*) AS n FROM note_tags').get() as {
      n: number;
    };
    const afterAlarmsRow = sqlite.prepare('SELECT count(*) AS n FROM reminder_status').get() as {
      n: number;
    };
    assert.equal(afterTagsRow.n, beforeTagsRow.n);
    assert.equal(afterAlarmsRow.n, beforeAlarmsRow.n);
    sqlite.close();
  });

  it('S6: FTS still matches notes after the migration', () => {
    const dbPath = join(tmp, 's6.db');
    seedV5Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 5, 6);

    const hit = sqlite.prepare('SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?').get('demo') as
      | { rowid: number }
      | undefined;
    assert.ok(hit, 'FTS should still match seeded note');
    sqlite.close();
  });

  it('S7: sync_changes table untouched (no new column, no row diff)', () => {
    const dbPath = join(tmp, 's7.db');
    seedV5Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    const beforeCols = (sqlite.pragma('table_info(sync_changes)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const beforeRow = sqlite
      .prepare('SELECT device_id, entity_type, op, client_change_id FROM sync_changes')
      .get() as { device_id: string; entity_type: string; op: string; client_change_id: string };

    applyForwardMigrations(sqlite, 5, 6);

    const afterCols = (sqlite.pragma('table_info(sync_changes)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const afterRow = sqlite
      .prepare('SELECT device_id, entity_type, op, client_change_id FROM sync_changes')
      .get() as { device_id: string; entity_type: string; op: string; client_change_id: string };

    assert.deepEqual(afterCols, beforeCols);
    assert.deepEqual(afterRow, beforeRow);
    sqlite.close();
  });

  it('S8: missing local_metadata.device_uuid is filled by INSERT OR IGNORE in the migration', () => {
    const dbPath = join(tmp, 's8.db');
    const sqlite = new BetterSqlite3(dbPath);
    sqlite.exec(readInitialSql());
    sqlite.pragma('user_version = 1');
    applyForwardMigrations(sqlite, 1, 5);
    // Intentionally don't seed local_metadata.device_uuid — represents
    // a migration that runs before ensureDeviceId.

    applyForwardMigrations(sqlite, 5, 6);

    const meta = sqlite
      .prepare("SELECT value FROM local_metadata WHERE key = 'device_uuid'")
      .get() as { value: string } | undefined;
    assert.ok(meta, 'migration must INSERT OR IGNORE a device_uuid');
    assert.match(meta.value, /^[0-9a-f]{32}$/);
    sqlite.close();
  });
});
