import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { LATEST_KNOWN_VERSION, createDatabase } from '../index.js';
import { probeStartupState } from './probe.js';

describe('probe — probeStartupState', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owl-probe-test-'));
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // PR1: file does not exist → kind:'not-found'
  it("PR1: returns not-found when the db file doesn't exist", () => {
    const dbPath = join(tmp, 'pr1-missing.db');
    const result = probeStartupState(dbPath);
    assert.deepStrictEqual(result, { kind: 'not-found' });
  });

  // PR2: v=LATEST, non-empty schema (via createDatabase())
  it('PR2: reports version + schemaEmpty=false on an initialized db', () => {
    const dbPath = join(tmp, 'pr2-latest.db');
    const { sqlite } = createDatabase({ dbPath });
    sqlite.close();

    const result = probeStartupState(dbPath);
    assert.deepStrictEqual(result, {
      kind: 'version',
      version: LATEST_KNOWN_VERSION,
      schemaEmpty: false,
    });
  });

  // PR3: v=0, empty schema (file exists but no user tables, user_version unset)
  it('PR3: reports version=0 + schemaEmpty=true on a fresh empty file', () => {
    const dbPath = join(tmp, 'pr3-empty.db');
    const sqlite = new BetterSqlite3(dbPath);
    try {
      // Touch nothing — no DDL, user_version remains 0 by default.
    } finally {
      sqlite.close();
    }

    const result = probeStartupState(dbPath);
    assert.deepStrictEqual(result, {
      kind: 'version',
      version: 0,
      schemaEmpty: true,
    });
  });

  // PR4: v=0, non-empty schema (legacy pre-v0.3 layout)
  it('PR4: reports version=0 + schemaEmpty=false on a pre-v0.3 legacy db', () => {
    const dbPath = join(tmp, 'pr4-legacy.db');
    const sqlite = new BetterSqlite3(dbPath);
    try {
      sqlite
        .prepare(
          'CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT)',
        )
        .run();
      sqlite
        .prepare(
          'CREATE TABLE notes (id TEXT PRIMARY KEY, folder_id TEXT, trash_level INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, trashed_at INTEGER, device_id TEXT, content_hash TEXT, content TEXT NOT NULL)',
        )
        .run();
      // user_version intentionally NOT set → remains 0
    } finally {
      sqlite.close();
    }

    const result = probeStartupState(dbPath);
    assert.deepStrictEqual(result, {
      kind: 'version',
      version: 0,
      schemaEmpty: false,
    });
  });

  // PR5: v > LATEST (future-version db)
  it('PR5: reports high user_version on a future-written db', () => {
    const dbPath = join(tmp, 'pr5-future.db');
    const future = 99;
    const sqlite = new BetterSqlite3(dbPath);
    try {
      sqlite.pragma(`user_version = ${future}`);
    } finally {
      sqlite.close();
    }

    const result = probeStartupState(dbPath);
    assert.deepStrictEqual(result, {
      kind: 'version',
      version: future,
      schemaEmpty: true,
    });
  });
});
