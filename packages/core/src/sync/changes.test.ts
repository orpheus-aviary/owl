import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import { emitSyncChange } from './changes.js';

interface SyncChangeRow {
  local_seq: number;
  device_id: string;
  entity_type: string;
  entity_id: string;
  op: string;
  payload: string;
  created_at: number;
}

function readAll(sqlite: Database.Database): SyncChangeRow[] {
  return sqlite.prepare('SELECT * FROM sync_changes ORDER BY local_seq').all() as SyncChangeRow[];
}

function clearAll(sqlite: Database.Database): void {
  sqlite.prepare('DELETE FROM sync_changes').run();
  sqlite.prepare('DELETE FROM local_metadata').run();
}

describe('emitSyncChange — basic shape', () => {
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    sqlite = result.sqlite;
  });

  beforeEach(() => {
    clearAll(sqlite);
  });

  after(() => {
    sqlite.close();
  });

  it('inserts a row with serialised payload + monotonic local_seq', () => {
    sqlite
      .prepare("INSERT INTO local_metadata (key, value) VALUES ('device_uuid', 'dev-fixed')")
      .run();

    emitSyncChange(sqlite, {
      entityType: 'note',
      entityId: 'note-1',
      op: 'create',
      payload: { content: 'hello', folder_id: null, trash_level: 0 },
      nowMs: 1_000,
    });
    emitSyncChange(sqlite, {
      entityType: 'note',
      entityId: 'note-1',
      op: 'update',
      payload: { updated_at_ms: 1_500 },
      nowMs: 2_000,
    });

    const rows = readAll(sqlite);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].local_seq, 1);
    assert.equal(rows[1].local_seq, 2);
    assert.equal(rows[0].device_id, 'dev-fixed');
    assert.equal(rows[0].entity_type, 'note');
    assert.equal(rows[0].entity_id, 'note-1');
    assert.equal(rows[0].op, 'create');
    assert.equal(rows[0].created_at, 1_000);
    const payload = JSON.parse(rows[0].payload);
    assert.equal(payload.content, 'hello');
    assert.equal(payload.folder_id, null);
  });

  it('uses Date.now() when nowMs is omitted', () => {
    sqlite.prepare("INSERT INTO local_metadata (key, value) VALUES ('device_uuid', 'dev-x')").run();
    const before = Date.now();
    emitSyncChange(sqlite, {
      entityType: 'folder',
      entityId: 'f-1',
      op: 'create',
      payload: {},
    });
    const after = Date.now();
    const row = readAll(sqlite)[0];
    assert.ok(row.created_at >= before && row.created_at <= after);
  });
});

describe('emitSyncChange — device_id auto-bootstrap', () => {
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    sqlite = result.sqlite;
  });

  beforeEach(() => {
    clearAll(sqlite);
  });

  after(() => {
    sqlite.close();
  });

  it('inserts a fresh device_uuid into local_metadata if missing', () => {
    // Sanity: empty local_metadata
    const pre = sqlite.prepare('SELECT count(*) AS n FROM local_metadata').get() as { n: number };
    assert.equal(pre.n, 0);

    emitSyncChange(sqlite, {
      entityType: 'note',
      entityId: 'n-1',
      op: 'create',
      payload: {},
    });

    const meta = sqlite
      .prepare("SELECT value FROM local_metadata WHERE key = 'device_uuid'")
      .get() as { value: string };
    assert.ok(meta.value);
    assert.equal(meta.value.length, 36, 'auto-init should be a UUID');

    const row = readAll(sqlite)[0];
    assert.equal(row.device_id, meta.value, 'sync_changes.device_id matches the inserted uuid');
  });

  it('reuses the stable device_uuid across calls', () => {
    emitSyncChange(sqlite, { entityType: 'note', entityId: 'a', op: 'create', payload: {} });
    emitSyncChange(sqlite, { entityType: 'note', entityId: 'b', op: 'create', payload: {} });
    const rows = readAll(sqlite);
    assert.equal(rows[0].device_id, rows[1].device_id);
  });

  it('does NOT overwrite an existing device_uuid', () => {
    sqlite
      .prepare("INSERT INTO local_metadata (key, value) VALUES ('device_uuid', 'dev-existing')")
      .run();

    emitSyncChange(sqlite, { entityType: 'note', entityId: 'n', op: 'create', payload: {} });

    const meta = sqlite
      .prepare("SELECT value FROM local_metadata WHERE key = 'device_uuid'")
      .get() as { value: string };
    assert.equal(meta.value, 'dev-existing');
  });
});

describe('emitSyncChange — transaction integration', () => {
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    sqlite = result.sqlite;
  });

  beforeEach(() => {
    clearAll(sqlite);
  });

  after(() => {
    sqlite.close();
  });

  it('rolls back the sync_changes row when the outer transaction aborts', () => {
    assert.throws(() => {
      sqlite
        .transaction(() => {
          emitSyncChange(sqlite, {
            entityType: 'note',
            entityId: 'will-rollback',
            op: 'create',
            payload: { content: 'x' },
          });
          throw new Error('simulate downstream failure');
        })
        .immediate();
    }, /simulate downstream failure/);

    const rows = readAll(sqlite);
    assert.equal(rows.length, 0);
  });
});
