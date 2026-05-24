import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import {
  countUnresolvedConflicts,
  ignoreConflict,
  listUnresolvedConflicts,
  recordConflict,
} from './conflicts.js';

describe('conflicts — recordConflict / list / count / ignore', () => {
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    sqlite = result.sqlite;
  });

  beforeEach(() => {
    sqlite.prepare('DELETE FROM conflict_record').run();
  });

  after(() => {
    sqlite.close();
  });

  it('C1: recordConflict round-trips payloads and timestamps', () => {
    const id = recordConflict(sqlite, {
      entityType: 'note',
      entityId: 'n1',
      losingSide: 'local',
      localPayload: { content: 'mine', updated_at_ms: 100 },
      remotePayload: { content: 'theirs', updated_at_ms: 200 },
      localUpdatedAtMs: 100,
      remoteUpdatedAtMs: 200,
      nowMs: 1000,
    });
    assert.match(id, /^[0-9a-f-]{36}$/);

    const row = sqlite.prepare('SELECT * FROM conflict_record WHERE id = ?').get(id) as Record<
      string,
      string | number | null
    >;
    assert.equal(row.entity_type, 'note');
    assert.equal(row.entity_id, 'n1');
    assert.equal(row.losing_side, 'local');
    assert.equal(row.detected_at, 1000);
    assert.equal(row.resolved_at, null);
    assert.equal(row.resolution, null);
    assert.equal(row.local_updated_at_ms, 100);
    assert.equal(row.remote_updated_at_ms, 200);
    assert.deepEqual(JSON.parse(row.local_payload as string), {
      content: 'mine',
      updated_at_ms: 100,
    });
    assert.deepEqual(JSON.parse(row.remote_payload as string), {
      content: 'theirs',
      updated_at_ms: 200,
    });
  });

  it('C2: countUnresolvedConflicts counts only resolved_at IS NULL rows', () => {
    recordConflict(sqlite, {
      entityType: 'note',
      entityId: 'n1',
      losingSide: 'local',
      localPayload: {},
      remotePayload: {},
      localUpdatedAtMs: 1,
      remoteUpdatedAtMs: 2,
    });
    recordConflict(sqlite, {
      entityType: 'note',
      entityId: 'n2',
      losingSide: 'local',
      localPayload: {},
      remotePayload: {},
      localUpdatedAtMs: 1,
      remoteUpdatedAtMs: 2,
    });
    assert.equal(countUnresolvedConflicts(sqlite), 2);

    // Resolve one — count drops to 1
    sqlite
      .prepare(
        "UPDATE conflict_record SET resolved_at = 999, resolution = 'ignored' WHERE entity_id = 'n1'",
      )
      .run();
    assert.equal(countUnresolvedConflicts(sqlite), 1);
  });

  it('C3: listUnresolvedConflicts returns newest detected_at first', () => {
    recordConflict(sqlite, {
      entityType: 'note',
      entityId: 'older',
      losingSide: 'local',
      localPayload: {},
      remotePayload: {},
      localUpdatedAtMs: 1,
      remoteUpdatedAtMs: 2,
      nowMs: 100,
    });
    recordConflict(sqlite, {
      entityType: 'note',
      entityId: 'newer',
      losingSide: 'local',
      localPayload: {},
      remotePayload: {},
      localUpdatedAtMs: 1,
      remoteUpdatedAtMs: 2,
      nowMs: 200,
    });
    const rows = listUnresolvedConflicts(sqlite);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].entity_id, 'newer');
    assert.equal(rows[1].entity_id, 'older');
  });

  it('C4: listUnresolvedConflicts excludes resolved rows and respects limit', () => {
    for (let i = 0; i < 3; i++) {
      recordConflict(sqlite, {
        entityType: 'note',
        entityId: `n${i}`,
        losingSide: 'local',
        localPayload: {},
        remotePayload: {},
        localUpdatedAtMs: 1,
        remoteUpdatedAtMs: 2,
        nowMs: 100 + i,
      });
    }
    sqlite
      .prepare(
        "UPDATE conflict_record SET resolved_at = 999, resolution = 'ignored' WHERE entity_id = 'n1'",
      )
      .run();
    const rows = listUnresolvedConflicts(sqlite, { limit: 10 });
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.entity_id),
      ['n2', 'n0'],
    );

    const limited = listUnresolvedConflicts(sqlite, { limit: 1 });
    assert.equal(limited.length, 1);
    assert.equal(limited[0].entity_id, 'n2');
  });

  it('C5: ignoreConflict soft-deletes (row stays, resolved_at set)', () => {
    const id = recordConflict(sqlite, {
      entityType: 'note',
      entityId: 'n1',
      losingSide: 'local',
      localPayload: {},
      remotePayload: {},
      localUpdatedAtMs: 1,
      remoteUpdatedAtMs: 2,
    });

    const changed = ignoreConflict(sqlite, id, { nowMs: 5000 });
    assert.equal(changed, true);

    const row = sqlite
      .prepare('SELECT resolved_at, resolution FROM conflict_record WHERE id = ?')
      .get(id) as { resolved_at: number | null; resolution: string | null };
    assert.equal(row.resolved_at, 5000);
    assert.equal(row.resolution, 'ignored');

    // Row not deleted
    const total = sqlite.prepare('SELECT count(*) AS n FROM conflict_record').get() as {
      n: number;
    };
    assert.equal(total.n, 1);
  });

  it('C6: ignoreConflict is idempotent (second call returns false, no double-stamp)', () => {
    const id = recordConflict(sqlite, {
      entityType: 'note',
      entityId: 'n1',
      losingSide: 'local',
      localPayload: {},
      remotePayload: {},
      localUpdatedAtMs: 1,
      remoteUpdatedAtMs: 2,
    });
    ignoreConflict(sqlite, id, { nowMs: 5000 });

    const second = ignoreConflict(sqlite, id, { nowMs: 9999 });
    assert.equal(second, false);

    const row = sqlite.prepare('SELECT resolved_at FROM conflict_record WHERE id = ?').get(id) as {
      resolved_at: number;
    };
    assert.equal(row.resolved_at, 5000, 'first ignore wins');
  });

  it('C7: ignoreConflict on missing id returns false (no row inserted)', () => {
    const changed = ignoreConflict(sqlite, 'nonexistent-id');
    assert.equal(changed, false);
    const total = sqlite.prepare('SELECT count(*) AS n FROM conflict_record').get() as {
      n: number;
    };
    assert.equal(total.n, 0);
  });

  it('C8: open dispatch — accepts arbitrary entity_type without migration', () => {
    recordConflict(sqlite, {
      entityType: 'folder',
      entityId: 'f1',
      losingSide: 'remote',
      localPayload: { name: 'local' },
      remotePayload: { name: 'remote' },
      localUpdatedAtMs: 1,
      remoteUpdatedAtMs: 2,
    });
    recordConflict(sqlite, {
      entityType: 'conversation',
      entityId: 'c1',
      losingSide: 'local',
      localPayload: {},
      remotePayload: {},
      localUpdatedAtMs: 1,
      remoteUpdatedAtMs: 2,
    });
    const rows = listUnresolvedConflicts(sqlite);
    const types = rows.map((r) => r.entity_type).sort();
    assert.deepEqual(types, ['conversation', 'folder']);
  });
});
