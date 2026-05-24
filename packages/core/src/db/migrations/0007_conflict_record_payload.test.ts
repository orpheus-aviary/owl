import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import BetterSqlite3 from 'better-sqlite3';
import { applyForwardMigrations, readInitialSql } from '../migrate.js';

/**
 * Seed a v=6 db (0001-0006 applied), with a placeholder row in
 * conflict_record so we can assert 0007 doesn't disturb the v4 columns.
 */
function seedV6Db(dbPath: string): void {
  const sqlite = new BetterSqlite3(dbPath);
  sqlite.exec(readInitialSql());
  sqlite.pragma('user_version = 1');
  applyForwardMigrations(sqlite, 1, 6);

  sqlite
    .prepare(
      `INSERT INTO conflict_record
         (id, entity_type, entity_id, local_seq, remote_seq, detected_at, resolved_at, resolution)
       VALUES (?, 'note', ?, 10, 20, ?, NULL, NULL)`,
    )
    .run('cr-pre', 'note-old', 1_700_000_000_000);

  sqlite.close();
}

describe('0007_conflict_record_payload', () => {
  let tmp: string;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'owl-0007-'));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('T1: ADD COLUMN losing_side / local_payload / remote_payload / *_updated_at_ms appears on conflict_record', () => {
    const dbPath = join(tmp, 't1.db');
    seedV6Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 6, 7);

    const cols = (sqlite.pragma('table_info(conflict_record)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    for (const expected of [
      'losing_side',
      'local_payload',
      'remote_payload',
      'local_updated_at_ms',
      'remote_updated_at_ms',
    ]) {
      assert.ok(cols.includes(expected), `missing column ${expected}`);
    }
    assert.equal(sqlite.pragma('user_version', { simple: true }) as number, 7);
    sqlite.close();
  });

  it('T2: pre-existing P4 row keeps its v4 columns; new payload columns are NULL', () => {
    const dbPath = join(tmp, 't2.db');
    seedV6Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 6, 7);

    const row = sqlite
      .prepare(
        `SELECT id, entity_type, entity_id, local_seq, remote_seq,
                detected_at, resolved_at, resolution,
                losing_side, local_payload, remote_payload,
                local_updated_at_ms, remote_updated_at_ms
           FROM conflict_record WHERE id = ?`,
      )
      .get('cr-pre') as Record<string, unknown>;
    assert.equal(row.entity_type, 'note');
    assert.equal(row.entity_id, 'note-old');
    assert.equal(row.local_seq, 10);
    assert.equal(row.remote_seq, 20);
    assert.equal(row.detected_at, 1_700_000_000_000);
    assert.equal(row.resolved_at, null);
    assert.equal(row.resolution, null);
    assert.equal(row.losing_side, null);
    assert.equal(row.local_payload, null);
    assert.equal(row.remote_payload, null);
    assert.equal(row.local_updated_at_ms, null);
    assert.equal(row.remote_updated_at_ms, null);
    sqlite.close();
  });

  it('T3: idx_conflict_unresolved is a partial index over resolved_at IS NULL', () => {
    const dbPath = join(tmp, 't3.db');
    seedV6Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 6, 7);

    const idx = sqlite
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name = ?")
      .get('idx_conflict_unresolved') as { name: string; sql: string } | undefined;
    assert.ok(idx, 'idx_conflict_unresolved must exist');
    assert.match(idx?.sql ?? '', /conflict_record/);
    assert.match(idx?.sql ?? '', /WHERE\s+resolved_at\s+IS\s+NULL/i);
    sqlite.close();
  });

  it('T4: fresh insert can fill new columns and round-trip JSON payloads', () => {
    const dbPath = join(tmp, 't4.db');
    seedV6Db(dbPath);
    const sqlite = new BetterSqlite3(dbPath);
    applyForwardMigrations(sqlite, 6, 7);

    const localPayload = JSON.stringify({ content: 'local copy', updated_at_ms: 100 });
    const remotePayload = JSON.stringify({ content: 'remote copy', updated_at_ms: 200 });
    sqlite
      .prepare(
        `INSERT INTO conflict_record
           (id, entity_type, entity_id, local_seq, remote_seq, detected_at,
            losing_side, local_payload, remote_payload,
            local_updated_at_ms, remote_updated_at_ms)
         VALUES (?, 'note', ?, NULL, NULL, ?, 'local', ?, ?, 100, 200)`,
      )
      .run('cr-new', 'note-1', 1_700_000_001_000, localPayload, remotePayload);

    const row = sqlite
      .prepare(
        `SELECT losing_side, local_payload, remote_payload,
                local_updated_at_ms, remote_updated_at_ms
           FROM conflict_record WHERE id = ?`,
      )
      .get('cr-new') as Record<string, string | number>;
    assert.equal(row.losing_side, 'local');
    assert.equal(row.local_payload, localPayload);
    assert.equal(row.remote_payload, remotePayload);
    assert.equal(row.local_updated_at_ms, 100);
    assert.equal(row.remote_updated_at_ms, 200);
    sqlite.close();
  });
});
