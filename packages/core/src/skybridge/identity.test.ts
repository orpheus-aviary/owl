import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import { ensureDeviceId } from '../db/special-notes.js';
import { clearSyncIdentity, persistSkybridgeIds, readSkybridgeDeviceId } from './identity.js';

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

describe('readSkybridgeDeviceId (P5-c G4)', () => {
  let sqlite: Database.Database;
  // biome-ignore lint/suspicious/noExplicitAny: drizzle wrapper type irrelevant
  let db: any;

  before(() => {
    const created = createDatabase({ dbPath: ':memory:' });
    sqlite = created.sqlite;
    db = created.db;
    ensureDeviceId(db);
  });

  after(() => {
    sqlite.close();
  });

  beforeEach(() => {
    sqlite.prepare("DELETE FROM local_metadata WHERE key = 'skybridge_device_id'").run();
  });

  it('returns null when skybridge_device_id row is absent (pre-login)', () => {
    assert.equal(readSkybridgeDeviceId(sqlite), null);
  });

  it('returns the persisted id after persistSkybridgeIds runs', () => {
    persistSkybridgeIds(sqlite, 'skybridge-xyz', 'ws-1');
    assert.equal(readSkybridgeDeviceId(sqlite), 'skybridge-xyz');
  });

  it('returns null when the row has explicit NULL value', () => {
    sqlite
      .prepare("INSERT INTO local_metadata (key, value) VALUES ('skybridge_device_id', NULL)")
      .run();
    assert.equal(readSkybridgeDeviceId(sqlite), null);
  });
});

// ─── clearSyncIdentity (P5-d Phase 6) ──────────────────────────────────

describe('clearSyncIdentity (P5-d Phase 6)', () => {
  let sqlite: Database.Database;
  // biome-ignore lint/suspicious/noExplicitAny: drizzle wrapper type irrelevant
  let db: any;

  before(() => {
    const created = createDatabase({ dbPath: ':memory:' });
    sqlite = created.sqlite;
    db = created.db;
    ensureDeviceId(db);
  });

  after(() => {
    sqlite.close();
  });

  beforeEach(() => {
    sqlite
      .prepare(
        "DELETE FROM local_metadata WHERE key IN ('skybridge_device_id', 'skybridge_workspace_id', 'skybridge_backfilled', 'cursor_pulled')",
      )
      .run();
  });

  function metaKeys(): string[] {
    return (
      sqlite.prepare('SELECT key FROM local_metadata ORDER BY key').all() as { key: string }[]
    ).map((r) => r.key);
  }

  it('deletes skybridge_device_id, skybridge_workspace_id, skybridge_backfilled', () => {
    persistSkybridgeIds(sqlite, 'dev-1', 'ws-1');
    assert.ok(metaKeys().includes('skybridge_device_id'));
    assert.ok(metaKeys().includes('skybridge_workspace_id'));
    assert.ok(metaKeys().includes('skybridge_backfilled'));

    clearSyncIdentity(sqlite);
    const keys = metaKeys();
    assert.ok(!keys.includes('skybridge_device_id'));
    assert.ok(!keys.includes('skybridge_workspace_id'));
    assert.ok(!keys.includes('skybridge_backfilled'));
  });

  it('leaves device_uuid (pre-skybridge local identity) untouched', () => {
    persistSkybridgeIds(sqlite, 'dev-1', 'ws-1');
    const beforeUuid = sqlite
      .prepare("SELECT value FROM local_metadata WHERE key = 'device_uuid'")
      .get() as { value: string } | undefined;
    assert.ok(beforeUuid?.value, 'precondition: device_uuid exists');

    clearSyncIdentity(sqlite);
    const afterUuid = sqlite
      .prepare("SELECT value FROM local_metadata WHERE key = 'device_uuid'")
      .get() as { value: string } | undefined;
    assert.equal(afterUuid?.value, beforeUuid.value, 'device_uuid must survive logout');
  });

  it('is idempotent — calling on already-clear local_metadata is a no-op', () => {
    clearSyncIdentity(sqlite);
    assert.doesNotThrow(() => clearSyncIdentity(sqlite));
  });
});
