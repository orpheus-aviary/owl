import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { type OwlDatabase, createDatabase } from '../db/index.js';
import { AlreadyTrashedError, VersionMismatchError } from '../notes/errors.js';
import { createNote, deleteNote, getNote } from '../notes/index.js';
import {
  BadPayload,
  ConflictNotFound,
  NoteNotFound,
  UnsupportedEntity,
  countUnresolvedConflicts,
  ignoreConflict,
  listUnresolvedConflicts,
  recordConflict,
  resolveConflict,
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

// ── W7: resolveConflict (用本地覆盖 / 合并) ──────────────────────────────

describe('conflicts — resolveConflict (W7)', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  beforeEach(() => {
    sqlite.prepare('DELETE FROM conflict_record').run();
    sqlite.prepare('DELETE FROM sync_changes').run();
    sqlite.prepare('DELETE FROM notes').run();
  });

  after(() => {
    sqlite.close();
  });

  /** Seed a note (remote/winning content) + a conflict row whose local_payload
   *  carries the losing copy. Returns the note + conflict id + CAS baseline. */
  function seed(opts: { remote: string; local?: string; localPayload?: unknown }) {
    const note = createNote(db, sqlite, { content: opts.remote });
    // Discard the create's outbox row so tests can assert the resolve emits one.
    sqlite.prepare('DELETE FROM sync_changes').run();
    const conflictId = recordConflict(sqlite, {
      entityType: 'note',
      entityId: note.id,
      losingSide: 'local',
      localPayload:
        'localPayload' in opts
          ? opts.localPayload
          : { content: opts.local ?? 'local copy', updated_at_ms: 100 },
      remotePayload: { content: opts.remote, updated_at_ms: 200 },
      localUpdatedAtMs: 100,
      remoteUpdatedAtMs: 200,
    });
    return { note, conflictId, baseline: note.updatedAt.getTime() };
  }

  function outboxUpdateCount(entityId: string): number {
    const row = sqlite
      .prepare("SELECT count(*) AS n FROM sync_changes WHERE entity_id = ? AND op = 'update'")
      .get(entityId) as { n: number };
    return row.n;
  }

  it('R1: local strategy overwrites note with local_payload.content + fresh stamp + outbox', () => {
    const { note, conflictId, baseline } = seed({ remote: 'REMOTE', local: 'LOCAL' });

    const res = resolveConflict(db, sqlite, conflictId, {
      strategy: 'local',
      expectedUpdatedAtMs: baseline,
    });

    assert.equal(res.resolved, true);
    assert.ok(res.resolved && res.note.content === 'LOCAL');
    // Fresh LWW stamp (>= baseline; server-normalized so may equal within same ms
    // but the row is a distinct write → assert the persisted note updated).
    const persisted = getNote(db, note.id);
    assert.equal(persisted?.content, 'LOCAL');
    assert.equal(outboxUpdateCount(note.id), 1, 'one sync_changes update row emitted');

    const row = sqlite
      .prepare('SELECT resolved_at, resolution FROM conflict_record WHERE id = ?')
      .get(conflictId) as { resolved_at: number | null; resolution: string | null };
    assert.ok(row.resolved_at, 'row stamped resolved');
    assert.equal(row.resolution, 'local');
    assert.equal(countUnresolvedConflicts(sqlite), 0);
  });

  it('R2: merged strategy writes the supplied content + resolution=merged', () => {
    const { note, conflictId, baseline } = seed({ remote: 'REMOTE', local: 'LOCAL' });

    const res = resolveConflict(db, sqlite, conflictId, {
      strategy: 'merged',
      content: 'MERGED RESULT',
      expectedUpdatedAtMs: baseline,
    });

    assert.equal(res.resolved, true);
    assert.equal(getNote(db, note.id)?.content, 'MERGED RESULT');
    const row = sqlite
      .prepare('SELECT resolution FROM conflict_record WHERE id = ?')
      .get(conflictId) as { resolution: string };
    assert.equal(row.resolution, 'merged');
    assert.equal(outboxUpdateCount(note.id), 1);
  });

  it('R3: merged empty string is legal (clears note content)', () => {
    const { note, conflictId, baseline } = seed({ remote: 'REMOTE' });
    const res = resolveConflict(db, sqlite, conflictId, {
      strategy: 'merged',
      content: '',
      expectedUpdatedAtMs: baseline,
    });
    assert.equal(res.resolved, true);
    assert.equal(getNote(db, note.id)?.content, '');
  });

  it('R4: stale CAS baseline → VersionMismatchError, note + conflict untouched (rollback)', () => {
    const { note, conflictId, baseline } = seed({ remote: 'REMOTE', local: 'LOCAL' });
    // Simulate the note being edited after the conflict was detected: its
    // updated_at advances past the caller's CAS baseline. (Direct column write
    // so the bump is deterministic — two same-ms writes wouldn't change it.)
    sqlite
      .prepare('UPDATE notes SET content = ?, updated_at = ? WHERE id = ?')
      .run('EDITED SINCE', baseline + 5000, note.id);

    assert.throws(
      () =>
        resolveConflict(db, sqlite, conflictId, {
          strategy: 'local',
          expectedUpdatedAtMs: baseline, // now stale
        }),
      VersionMismatchError,
    );

    // Note keeps the newer edit; conflict row NOT marked resolved (preemption
    // rolled back with the failed write).
    assert.equal(getNote(db, note.id)?.content, 'EDITED SINCE');
    assert.equal(countUnresolvedConflicts(sqlite), 1);
    const row = sqlite
      .prepare('SELECT resolved_at FROM conflict_record WHERE id = ?')
      .get(conflictId) as { resolved_at: number | null };
    assert.equal(row.resolved_at, null);
  });

  it('R5: already-resolved row → {resolved:false, already_resolved}, no second write', () => {
    const { note, conflictId, baseline } = seed({ remote: 'REMOTE', local: 'LOCAL' });
    resolveConflict(db, sqlite, conflictId, { strategy: 'local', expectedUpdatedAtMs: baseline });
    const afterFirst = getNote(db, note.id)?.updatedAt.getTime();
    const before = outboxUpdateCount(note.id);

    const second = resolveConflict(db, sqlite, conflictId, {
      strategy: 'merged',
      content: 'SHOULD NOT APPLY',
      expectedUpdatedAtMs: afterFirst ?? 0,
    });
    assert.deepEqual(second, { resolved: false, reason: 'already_resolved' });
    assert.equal(getNote(db, note.id)?.content, 'LOCAL', 'note not re-written');
    assert.equal(outboxUpdateCount(note.id), before, 'no extra outbox row');
  });

  it('R6: unknown conflict id → ConflictNotFound', () => {
    assert.throws(
      () => resolveConflict(db, sqlite, 'nope', { strategy: 'local', expectedUpdatedAtMs: 0 }),
      ConflictNotFound,
    );
  });

  it('R7: conflict points at a missing note → NoteNotFound, row rolled back', () => {
    const conflictId = recordConflict(sqlite, {
      entityType: 'note',
      entityId: 'ghost-note',
      losingSide: 'local',
      localPayload: { content: 'x' },
      remotePayload: { content: 'y' },
      localUpdatedAtMs: 1,
      remoteUpdatedAtMs: 2,
    });
    assert.throws(
      () => resolveConflict(db, sqlite, conflictId, { strategy: 'local', expectedUpdatedAtMs: 0 }),
      NoteNotFound,
    );
    // preemption rolled back
    assert.equal(countUnresolvedConflicts(sqlite), 1);
  });

  it('R8: trashed note → AlreadyTrashedError, row rolled back', () => {
    const { note, conflictId } = seed({ remote: 'REMOTE', local: 'LOCAL' });
    deleteNote(db, sqlite, note.id); // trash_level 0 → 1
    const trashedBaseline = getNote(db, note.id)?.updatedAt.getTime() ?? 0;

    assert.throws(
      () =>
        resolveConflict(db, sqlite, conflictId, {
          strategy: 'local',
          expectedUpdatedAtMs: trashedBaseline,
        }),
      AlreadyTrashedError,
    );
    assert.equal(countUnresolvedConflicts(sqlite), 1, 'conflict still unresolved');
  });

  it('R9: non-note entity → UnsupportedEntity', () => {
    const conflictId = recordConflict(sqlite, {
      entityType: 'folder',
      entityId: 'f1',
      losingSide: 'local',
      localPayload: { name: 'a' },
      remotePayload: { name: 'b' },
      localUpdatedAtMs: 1,
      remoteUpdatedAtMs: 2,
    });
    assert.throws(
      () =>
        resolveConflict(db, sqlite, conflictId, {
          strategy: 'merged',
          content: 'x',
          expectedUpdatedAtMs: 0,
        }),
      UnsupportedEntity,
    );
  });

  it('R10: local strategy with unparseable / non-string payload → BadPayload', () => {
    // (a) raw invalid JSON in the column → JSON.parse throws
    const bad = seed({ remote: 'REMOTE', local: 'x' });
    sqlite
      .prepare('UPDATE conflict_record SET local_payload = ? WHERE id = ?')
      .run('not json{', bad.conflictId);
    assert.throws(
      () =>
        resolveConflict(db, sqlite, bad.conflictId, {
          strategy: 'local',
          expectedUpdatedAtMs: bad.baseline,
        }),
      BadPayload,
    );

    // (b) valid JSON but content not a string
    const bad2 = seed({ remote: 'REMOTE', localPayload: { content: 42 } });
    assert.throws(
      () =>
        resolveConflict(db, sqlite, bad2.conflictId, {
          strategy: 'local',
          expectedUpdatedAtMs: bad2.baseline,
        }),
      BadPayload,
    );
  });
});
