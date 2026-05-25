import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { applyForwardMigrations, readInitialSql } from '../migrate.js';

// 0008 backfills missing `create` ops in sync_changes for legacy notes /
// folders that pre-date the P4 outbox trigger. Manual M5 audit caught
// the symptom: profile B (fresh nest) bootstrapped to 45 live notes
// while A had 58, dropping 13 real user notes that only had update /
// pin ops on the wire — see docs/plans/2026-05-25-p5-c-manual-bugs.md
// #2 for the full story.

function seedV7Db(dbPath: string): void {
  const sqlite = new BetterSqlite3(dbPath);
  sqlite.exec(readInitialSql());
  sqlite.pragma('user_version = 1');
  applyForwardMigrations(sqlite, 1, 7);

  // 0006 already seeded a random device_uuid; replace with a known one
  // so the assertions can match against a fixed value.
  sqlite
    .prepare("INSERT OR REPLACE INTO local_metadata (key, value) VALUES ('device_uuid', ?)")
    .run('dev-A-uuid');

  // LEGACY note: in notes table, no sync_changes row at all
  sqlite
    .prepare(
      `INSERT INTO notes (id, content, content_hash, folder_id, trash_level,
                          created_at, updated_at, device_id, local_device_uuid)
         VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?)`,
    )
    .run(
      'n-legacy',
      '# 续费\n\n',
      'h-legacy',
      1_700_000_000_000,
      1_700_000_001_000,
      'dev-A',
      'dev-A-uuid',
    );

  // LEGACY-WITH-UPDATE: only an `update` row — mirrors f42b01e3 in prod
  sqlite
    .prepare(
      `INSERT INTO notes (id, content, content_hash, folder_id, trash_level,
                          created_at, updated_at, device_id, local_device_uuid)
         VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?)`,
    )
    .run(
      'n-legacy-upd',
      '# gitea\n\n',
      'h-legacy-upd',
      1_700_000_002_000,
      1_700_000_003_000,
      'dev-A',
      'dev-A-uuid',
    );
  sqlite
    .prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at,
          client_change_id, synced_at, server_seq)
         VALUES (?, 'note', 'n-legacy-upd', 'update', ?, ?, ?, ?, ?)`,
    )
    .run(
      'dev-A-uuid',
      '{"updated_at_ms": 1700000003000, "content": "old"}',
      1_700_000_003_500,
      'cid-upd-1',
      1_700_000_003_900,
      50,
    );

  // MODERN note: already has a proper `create` op
  sqlite
    .prepare(
      `INSERT INTO notes (id, content, content_hash, folder_id, trash_level,
                          created_at, updated_at, device_id, local_device_uuid)
         VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?)`,
    )
    .run(
      'n-modern',
      '# new\n\n',
      'h-modern',
      1_710_000_000_000,
      1_710_000_001_000,
      'dev-A',
      'dev-A-uuid',
    );
  sqlite
    .prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at,
          client_change_id, synced_at, server_seq)
         VALUES (?, 'note', 'n-modern', 'create', ?, ?, ?, ?, ?)`,
    )
    .run(
      'dev-A-uuid',
      '{"content":"# new\\n\\n","folder_id":null,"trash_level":0,"created_at_ms":1710000000000,"updated_at_ms":1710000001000,"tags":[]}',
      1_710_000_001_500,
      'cid-modern-1',
      1_710_000_001_900,
      60,
    );

  // SPECIAL note: SPECIAL_NOTES.MEMO id, every device materialises locally
  sqlite
    .prepare(
      `INSERT INTO notes (id, content, content_hash, folder_id, trash_level,
                          created_at, updated_at, device_id, local_device_uuid)
         VALUES (?, ?, ?, NULL, 0, ?, ?, ?, ?)`,
    )
    .run(
      '00000000-0000-0000-0000-000000000001',
      '# 随记\n\n',
      'h-memo',
      1_700_000_010_000,
      1_700_000_010_000,
      'dev-A',
      'dev-A-uuid',
    );

  // Tag attached to n-legacy so the tag aggregation branch is exercised
  sqlite.prepare("INSERT INTO tags (id, tag_type, tag_value) VALUES ('t1', '#', '续费')").run();
  sqlite.prepare("INSERT INTO note_tags (note_id, tag_id) VALUES ('n-legacy', 't1')").run();

  // LEGACY folder
  sqlite
    .prepare(
      `INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, device_id, local_device_uuid)
         VALUES (?, ?, NULL, 0, ?, ?, ?, ?)`,
    )
    .run('f-legacy', '归档', 1_700_000_020_000, 1_700_000_020_000, 'dev-A', 'dev-A-uuid');

  // MODERN folder
  sqlite
    .prepare(
      `INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, device_id, local_device_uuid)
         VALUES (?, ?, NULL, 1, ?, ?, ?, ?)`,
    )
    .run('f-modern', '开发', 1_710_000_020_000, 1_710_000_020_000, 'dev-A', 'dev-A-uuid');
  sqlite
    .prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at,
          client_change_id, synced_at, server_seq)
         VALUES (?, 'folder', 'f-modern', 'create', ?, ?, ?, ?, ?)`,
    )
    .run(
      'dev-A-uuid',
      '{"name":"开发","parent_id":null,"position":1,"created_at_ms":1710000020000,"updated_at_ms":1710000020000}',
      1_710_000_020_500,
      'cid-modern-f',
      1_710_000_020_900,
      70,
    );

  sqlite.close();
}

interface SyncChangeRow {
  entity_id: string;
  op: string;
  payload: string;
  client_change_id: string;
  synced_at: number | null;
  server_seq: number | null;
}

describe('0008_backfill_create_ops', () => {
  let tmp: string;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owl-0008-'));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('T1: legacy note (no sync_changes) gets a create op with current snapshot', () => {
    const dbPath = join(tmp, 't1.db');
    seedV7Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 7, 8);
    assert.equal(sqlite.pragma('user_version', { simple: true }) as number, 8);

    const created = sqlite
      .prepare("SELECT * FROM sync_changes WHERE entity_id='n-legacy' AND op='create'")
      .all() as SyncChangeRow[];
    assert.equal(created.length, 1, 'exactly one create op for legacy note');
    const row = created[0];
    if (!row) throw new Error('unreachable');

    const payload = JSON.parse(row.payload) as {
      content: string;
      folder_id: string | null;
      trash_level: number;
      created_at_ms: number;
      updated_at_ms: number;
      tags: { tag_type: string; tag_value: string }[];
    };
    assert.equal(payload.content, '# 续费\n\n');
    assert.equal(payload.folder_id, null);
    assert.equal(payload.trash_level, 0);
    assert.equal(payload.created_at_ms, 1_700_000_000_000);
    assert.equal(payload.updated_at_ms, 1_700_000_001_000);
    assert.deepEqual(payload.tags, [{ tag_type: '#', tag_value: '续费' }]);

    assert.equal(row.synced_at, null, 'unpushed');
    assert.equal(row.server_seq, null, 'no server seq yet');
    assert.match(row.client_change_id, /^[0-9a-f]{32}$/);
    sqlite.close();
  });

  it('T2: legacy-with-update-only note gets a create op too (the M5 case)', () => {
    const dbPath = join(tmp, 't2.db');
    seedV7Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 7, 8);

    const ops = sqlite
      .prepare("SELECT op FROM sync_changes WHERE entity_id='n-legacy-upd' ORDER BY local_seq")
      .all() as { op: string }[];
    assert.deepEqual(ops.map((r) => r.op).sort(), ['create', 'update']);
    sqlite.close();
  });

  it('T3: modern note (already has create) is skipped — no duplicate', () => {
    const dbPath = join(tmp, 't3.db');
    seedV7Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 7, 8);

    const creates = sqlite
      .prepare("SELECT COUNT(*) AS n FROM sync_changes WHERE entity_id='n-modern' AND op='create'")
      .get() as { n: number };
    assert.equal(creates.n, 1);
    sqlite.close();
  });

  it('T4: SPECIAL_NOTES are skipped — every device materialises locally', () => {
    const dbPath = join(tmp, 't4.db');
    seedV7Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 7, 8);

    const creates = sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM sync_changes WHERE entity_id='00000000-0000-0000-0000-000000000001' AND op='create'",
      )
      .get() as { n: number };
    assert.equal(creates.n, 0, 'no backfill for SPECIAL_NOTES.MEMO');
    sqlite.close();
  });

  it('T5: legacy folder gets a create op with current snapshot', () => {
    const dbPath = join(tmp, 't5.db');
    seedV7Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 7, 8);

    const created = sqlite
      .prepare("SELECT * FROM sync_changes WHERE entity_id='f-legacy' AND op='create'")
      .all() as SyncChangeRow[];
    assert.equal(created.length, 1);
    const row = created[0];
    if (!row) throw new Error('unreachable');

    const payload = JSON.parse(row.payload) as {
      name: string;
      parent_id: string | null;
      position: number;
      created_at_ms: number;
      updated_at_ms: number;
    };
    assert.equal(payload.name, '归档');
    assert.equal(payload.parent_id, null);
    assert.equal(payload.position, 0);
    sqlite.close();
  });

  it('T6: modern folder (already has create) is skipped', () => {
    const dbPath = join(tmp, 't6.db');
    seedV7Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 7, 8);

    const creates = sqlite
      .prepare("SELECT COUNT(*) AS n FROM sync_changes WHERE entity_id='f-modern' AND op='create'")
      .get() as { n: number };
    assert.equal(creates.n, 1);
    sqlite.close();
  });

  it('T7: idempotent — running 0008 twice never duplicates', () => {
    const dbPath = join(tmp, 't7.db');
    seedV7Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 7, 8);

    const before = sqlite
      .prepare("SELECT COUNT(*) AS n FROM sync_changes WHERE op='create'")
      .get() as { n: number };

    sqlite.pragma('user_version = 7');
    applyForwardMigrations(sqlite, 7, 8);

    const after = sqlite
      .prepare("SELECT COUNT(*) AS n FROM sync_changes WHERE op='create'")
      .get() as { n: number };
    assert.equal(after.n, before.n, 'no duplicates on re-run');
    sqlite.close();
  });

  it('T8: backfilled rows use local device_uuid', () => {
    const dbPath = join(tmp, 't8.db');
    seedV7Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 7, 8);

    const row = sqlite
      .prepare("SELECT device_id FROM sync_changes WHERE entity_id='n-legacy' AND op='create'")
      .get() as { device_id: string };
    assert.equal(row.device_id, 'dev-A-uuid');
    sqlite.close();
  });
});
