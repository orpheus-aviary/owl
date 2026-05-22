import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import { ensureDeviceId } from '../db/special-notes.js';
import { persistSkybridgeIds } from './identity.js';

const SKYBRIDGE_DEVICE_ID = 'skybridge-dev-abc';
const SKYBRIDGE_WORKSPACE_ID = 'ws-1';

describe('persistSkybridgeIds (P5-b §6.1)', () => {
  let sqlite: Database.Database;
  // biome-ignore lint/suspicious/noExplicitAny: drizzle wrapper type irrelevant
  let db: any;
  let localUuid: string;

  before(() => {
    const created = createDatabase({ dbPath: ':memory:' });
    sqlite = created.sqlite;
    db = created.db;
    localUuid = ensureDeviceId(db);
  });

  after(() => {
    sqlite.close();
  });

  beforeEach(() => {
    sqlite.prepare('DELETE FROM notes').run();
    sqlite.prepare('DELETE FROM folders').run();
    sqlite
      .prepare(
        "DELETE FROM local_metadata WHERE key IN ('skybridge_device_id', 'skybridge_workspace_id', 'skybridge_backfilled')",
      )
      .run();
  });

  function insertNote(id: string, deviceId: string | null): void {
    sqlite
      .prepare(
        `INSERT INTO notes (id, trash_level, created_at, updated_at, content, device_id, local_device_uuid)
         VALUES (?, 0, 0, 0, ?, ?, ?)`,
      )
      .run(id, `c-${id}`, deviceId, localUuid);
  }

  function insertFolder(id: string, deviceId: string | null): void {
    sqlite
      .prepare(
        `INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, device_id, local_device_uuid)
         VALUES (?, ?, NULL, 0, 0, 0, ?, ?)`,
      )
      .run(id, `f-${id}`, deviceId, localUuid);
  }

  function readMeta(key: string): string | undefined {
    const row = sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(key) as
      | { value: string | null }
      | undefined;
    return row?.value ?? undefined;
  }

  it('writes skybridge_device_id + skybridge_workspace_id into local_metadata', () => {
    persistSkybridgeIds(sqlite, SKYBRIDGE_DEVICE_ID, SKYBRIDGE_WORKSPACE_ID);
    assert.equal(readMeta('skybridge_device_id'), SKYBRIDGE_DEVICE_ID);
    assert.equal(readMeta('skybridge_workspace_id'), SKYBRIDGE_WORKSPACE_ID);
    assert.equal(readMeta('skybridge_backfilled'), '1');
  });

  it('backfills notes.device_id from NULL or local-uuid to skybridge id', () => {
    insertNote('n-null', null);
    insertNote('n-loc', localUuid);
    insertNote('n-remote', 'some-other-device');

    persistSkybridgeIds(sqlite, SKYBRIDGE_DEVICE_ID, SKYBRIDGE_WORKSPACE_ID);

    const rows = sqlite.prepare('SELECT id, device_id FROM notes ORDER BY id').all() as Array<{
      id: string;
      device_id: string | null;
    }>;
    assert.equal(rows.find((r) => r.id === 'n-null')?.device_id, SKYBRIDGE_DEVICE_ID);
    assert.equal(rows.find((r) => r.id === 'n-loc')?.device_id, SKYBRIDGE_DEVICE_ID);
    // remote row not stamped — apply-written rows preserved
    assert.equal(rows.find((r) => r.id === 'n-remote')?.device_id, 'some-other-device');
  });

  it('backfills folders.device_id from NULL or local-uuid to skybridge id', () => {
    insertFolder('f-null', null);
    insertFolder('f-loc', localUuid);
    insertFolder('f-remote', 'other-dev');

    persistSkybridgeIds(sqlite, SKYBRIDGE_DEVICE_ID, SKYBRIDGE_WORKSPACE_ID);

    const rows = sqlite.prepare('SELECT id, device_id FROM folders ORDER BY id').all() as Array<{
      id: string;
      device_id: string | null;
    }>;
    assert.equal(rows.find((r) => r.id === 'f-null')?.device_id, SKYBRIDGE_DEVICE_ID);
    assert.equal(rows.find((r) => r.id === 'f-loc')?.device_id, SKYBRIDGE_DEVICE_ID);
    assert.equal(rows.find((r) => r.id === 'f-remote')?.device_id, 'other-dev');
  });

  it('is idempotent: second call does not re-stamp remote-written rows', () => {
    insertNote('n-1', localUuid);
    persistSkybridgeIds(sqlite, SKYBRIDGE_DEVICE_ID, SKYBRIDGE_WORKSPACE_ID);
    sqlite.prepare('UPDATE notes SET device_id = ? WHERE id = ?').run('remote-A', 'n-1');
    persistSkybridgeIds(sqlite, SKYBRIDGE_DEVICE_ID, SKYBRIDGE_WORKSPACE_ID);

    const r = sqlite.prepare('SELECT device_id FROM notes WHERE id = ?').get('n-1') as {
      device_id: string;
    };
    assert.equal(r.device_id, 'remote-A');
  });

  it('updates skybridge_device_id when called with a different id (e.g. re-register)', () => {
    persistSkybridgeIds(sqlite, SKYBRIDGE_DEVICE_ID, SKYBRIDGE_WORKSPACE_ID);
    persistSkybridgeIds(sqlite, 'new-dev-id', 'new-ws');
    assert.equal(readMeta('skybridge_device_id'), 'new-dev-id');
    assert.equal(readMeta('skybridge_workspace_id'), 'new-ws');
  });
});
