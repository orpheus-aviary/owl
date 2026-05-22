import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import type { OwlDatabase } from '../db/index.js';
import { ensureSpecialNotes } from '../db/special-notes.js';
import { searchNotes, searchNotesWithDetails } from '../search/index.js';
import { AlreadyTrashedError, VersionMismatchError } from './errors.js';
import {
  batchDeleteNotes,
  batchRestoreNotes,
  createNote,
  deleteNote,
  getNote,
  listAlarmNotes,
  listNotes,
  permanentDeleteNote,
  reorderNotesInFolder,
  restoreNote,
  setNotePinned,
  updateNote,
} from './index.js';

describe('notes CRUD', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  after(() => {
    sqlite.close();
  });

  it('creates a note', () => {
    const note = createNote(db, sqlite, { content: '# Test Note\n\nHello world' });
    assert.ok(note.id);
    assert.equal(note.content, '# Test Note\n\nHello world');
    assert.equal(note.trashLevel, 0);
    assert.ok(note.contentHash);
  });

  it('creates a note with tags', () => {
    const note = createNote(db, sqlite, {
      content: 'Tagged note',
      tags: [
        { tagType: '#', tagValue: '工作' },
        { tagType: '#', tagValue: '重要' },
      ],
    });
    assert.equal(note.tags.length, 2);
    assert.ok(note.tags.some((t) => t.tagValue === '工作'));
  });

  it('gets a note by id', () => {
    const created = createNote(db, sqlite, { content: 'Get me' });
    const found = getNote(db, created.id);
    assert.ok(found);
    assert.equal(found.id, created.id);
  });

  it('returns null for non-existent note', () => {
    assert.equal(getNote(db, 'non-existent-id'), null);
  });

  it('lists notes with pagination', () => {
    // Create several notes
    for (let i = 0; i < 5; i++) {
      createNote(db, sqlite, { content: `Paginated note ${i}` });
    }

    const page1 = listNotes(db, sqlite, { limit: 3, page: 1 });
    assert.equal(page1.items.length, 3);
    assert.ok(page1.total >= 5);

    const page2 = listNotes(db, sqlite, { limit: 3, page: 2 });
    assert.ok(page2.items.length > 0);
  });

  it('updates note content', () => {
    const note = createNote(db, sqlite, { content: 'Original' });
    const updated = updateNote(db, sqlite, note.id, { content: 'Updated content' });
    assert.ok(updated);
    assert.equal(updated.content, 'Updated content');
    assert.notEqual(updated.contentHash, note.contentHash);
  });

  it('updates note tags', () => {
    const note = createNote(db, sqlite, {
      content: 'Tag update test',
      tags: [{ tagType: '#', tagValue: 'old' }],
    });
    assert.equal(note.tags.length, 1);

    const updated = updateNote(db, sqlite, note.id, {
      tags: [
        { tagType: '#', tagValue: 'new1' },
        { tagType: '#', tagValue: 'new2' },
      ],
    });
    assert.ok(updated);
    assert.equal(updated.tags.length, 2);
    assert.ok(updated.tags.every((t) => t.tagValue !== 'old'));
  });

  it('soft deletes a note', () => {
    const note = createNote(db, sqlite, { content: 'Delete me' });
    assert.ok(deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 }));

    const deleted = getNote(db, note.id);
    assert.ok(deleted);
    assert.equal(deleted.trashLevel, 1);
    // Level 1 does not stamp a deadline
    assert.equal(deleted.autoDeleteAt, null);
  });

  it('stamps auto_delete_at when reaching level 2', () => {
    const note = createNote(db, sqlite, { content: 'Promote me' });
    deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 }); // → level 1
    const before = Date.now();
    deleteNote(db, sqlite, note.id, { autoDeleteDays: 7 }); // → level 2
    const promoted = getNote(db, note.id);
    assert.ok(promoted);
    assert.equal(promoted.trashLevel, 2);
    assert.ok(promoted.autoDeleteAt);
    const deadline = promoted.autoDeleteAt.getTime();
    // Should be ~ now + 7 days
    assert.ok(deadline >= before + 7 * 86_400_000 - 1000);
    assert.ok(deadline <= Date.now() + 7 * 86_400_000 + 1000);
  });

  it('restores a note and clears auto_delete_at', () => {
    const note = createNote(db, sqlite, { content: 'Restore me' });
    deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 });
    deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 }); // level 2, stamped
    assert.ok(getNote(db, note.id)?.autoDeleteAt);
    assert.ok(restoreNote(db, sqlite, note.id));

    const restored = getNote(db, note.id);
    assert.ok(restored);
    assert.equal(restored.trashLevel, 1);
    assert.equal(restored.autoDeleteAt, null);
  });

  it('permanently deletes a note', () => {
    const note = createNote(db, sqlite, { content: 'Perm delete' });
    assert.ok(permanentDeleteNote(db, sqlite, note.id));
    assert.equal(getNote(db, note.id), null);
  });

  it('batch deletes notes', () => {
    const n1 = createNote(db, sqlite, { content: 'Batch 1' });
    const n2 = createNote(db, sqlite, { content: 'Batch 2' });
    const count = batchDeleteNotes(db, sqlite, [n1.id, n2.id], 30);
    assert.equal(count, 2);
  });

  it('batch restores notes', () => {
    const n1 = createNote(db, sqlite, { content: 'Batch restore 1' });
    const n2 = createNote(db, sqlite, { content: 'Batch restore 2' });
    batchDeleteNotes(db, sqlite, [n1.id, n2.id], 30);
    const count = batchRestoreNotes(db, sqlite, [n1.id, n2.id]);
    assert.equal(count, 2);
  });

  it('refuses to trash or permanent-delete a special note', () => {
    const MEMO = '00000000-0000-0000-0000-000000000001';
    const TODO = '00000000-0000-0000-0000-000000000002';
    // createDatabase doesn't seed special notes — the daemon's AppContext
    // bootstrap does. Call it here so the guard actually has rows to find.
    ensureSpecialNotes(db);
    assert.equal(deleteNote(db, sqlite, MEMO, { autoDeleteDays: 30 }), null);
    assert.equal(deleteNote(db, sqlite, TODO, { autoDeleteDays: 30 }), null);
    assert.equal(permanentDeleteNote(db, sqlite, MEMO), false);
    assert.equal(permanentDeleteNote(db, sqlite, TODO), false);
    const memo = getNote(db, MEMO);
    assert.ok(memo);
    assert.equal(memo.trashLevel, 0);
  });

  // ─── CAS & opts (P3.2-c §4.3) ────────────────────────────

  it('updateNote with matching expectedUpdatedAt succeeds', () => {
    const note = createNote(db, sqlite, { content: 'cas-update-1' });
    const baseline = note.updatedAt.getTime();
    const updated = updateNote(
      db,
      sqlite,
      note.id,
      { content: 'updated' },
      { expectedUpdatedAt: baseline },
    );
    assert.ok(updated);
    assert.equal(updated.content, 'updated');
  });

  it('updateNote with mismatched expectedUpdatedAt throws VersionMismatchError', () => {
    const note = createNote(db, sqlite, { content: 'cas-update-2' });
    assert.throws(
      () =>
        updateNote(
          db,
          sqlite,
          note.id,
          { content: 'clobber' },
          { expectedUpdatedAt: note.updatedAt.getTime() - 1 },
        ),
      (err: unknown) =>
        err instanceof VersionMismatchError &&
        err.id === note.id &&
        err.expected === note.updatedAt.getTime() - 1,
    );
    // Content must remain untouched
    const after = getNote(db, note.id);
    assert.equal(after?.content, 'cas-update-2');
  });

  it('updateNote returns null for missing id', () => {
    const result = updateNote(db, sqlite, '00000000-0000-0000-0000-deadbeefdead', { content: 'x' });
    assert.equal(result, null);
  });

  it('deleteNote returns the updated note (not boolean)', () => {
    const note = createNote(db, sqlite, { content: 'del-ret' });
    const result = deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 });
    assert.ok(result);
    assert.equal(result.id, note.id);
    assert.equal(result.trashLevel, 1);
    assert.equal(result.autoDeleteAt, null);
  });

  it('deleteNote with matching expectedUpdatedAt succeeds', () => {
    const note = createNote(db, sqlite, { content: 'cas-del-1' });
    const result = deleteNote(db, sqlite, note.id, {
      autoDeleteDays: 30,
      expectedUpdatedAt: note.updatedAt.getTime(),
    });
    assert.ok(result);
    assert.equal(result.trashLevel, 1);
  });

  it('deleteNote with mismatched expectedUpdatedAt throws VersionMismatchError', () => {
    const note = createNote(db, sqlite, { content: 'cas-del-2' });
    assert.throws(
      () =>
        deleteNote(db, sqlite, note.id, {
          autoDeleteDays: 30,
          expectedUpdatedAt: note.updatedAt.getTime() - 1,
        }),
      (err: unknown) => err instanceof VersionMismatchError && err.id === note.id,
    );
    // Untouched
    assert.equal(getNote(db, note.id)?.trashLevel, 0);
  });

  it('deleteNote rejects trashed note when rejectIfTrashed=true', () => {
    const note = createNote(db, sqlite, { content: 'reject-trashed' });
    deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 }); // → level 1
    assert.throws(
      () => deleteNote(db, sqlite, note.id, { autoDeleteDays: 30, rejectIfTrashed: true }),
      (err: unknown) =>
        err instanceof AlreadyTrashedError && err.id === note.id && err.currentTrashLevel === 1,
    );
    // Still at level 1, no upgrade
    assert.equal(getNote(db, note.id)?.trashLevel, 1);
  });

  it('deleteNote default (rejectIfTrashed absent) still upgrades level 1 → 2', () => {
    const note = createNote(db, sqlite, { content: 'upgrade-path' });
    deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 });
    const promoted = deleteNote(db, sqlite, note.id, { autoDeleteDays: 7 });
    assert.ok(promoted);
    assert.equal(promoted.trashLevel, 2);
    assert.ok(promoted.autoDeleteAt);
  });

  it('deleteNote returns null for missing id', () => {
    const result = deleteNote(db, sqlite, '00000000-0000-0000-0000-deadbeefdead', {
      autoDeleteDays: 30,
    });
    assert.equal(result, null);
  });

  it('restoreNote returns the updated note (not boolean)', () => {
    const note = createNote(db, sqlite, { content: 'restore-ret' });
    deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 });
    const result = restoreNote(db, sqlite, note.id);
    assert.ok(result);
    assert.equal(result.trashLevel, 0);
  });

  it('restoreNote with matching expectedUpdatedAt succeeds', () => {
    const note = createNote(db, sqlite, { content: 'cas-restore-1' });
    const deleted = deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 });
    assert.ok(deleted);
    const result = restoreNote(db, sqlite, note.id, {
      expectedUpdatedAt: deleted.updatedAt.getTime(),
    });
    assert.ok(result);
    assert.equal(result.trashLevel, 0);
  });

  it('restoreNote with mismatched expectedUpdatedAt throws VersionMismatchError', () => {
    const note = createNote(db, sqlite, { content: 'cas-restore-2' });
    const deleted = deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 });
    assert.ok(deleted);
    assert.throws(
      () =>
        restoreNote(db, sqlite, note.id, { expectedUpdatedAt: deleted.updatedAt.getTime() - 1 }),
      (err: unknown) => err instanceof VersionMismatchError && err.id === note.id,
    );
    // Still trashed
    assert.equal(getNote(db, note.id)?.trashLevel, 1);
  });

  it('restoreNote returns null for missing id', () => {
    const result = restoreNote(db, sqlite, '00000000-0000-0000-0000-deadbeefdead');
    assert.equal(result, null);
  });

  it('restoreNote returns null for not-trashed note', () => {
    const note = createNote(db, sqlite, { content: 'fresh' });
    const result = restoreNote(db, sqlite, note.id);
    assert.equal(result, null);
  });
});

describe('listAlarmNotes', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  after(() => {
    sqlite.close();
  });

  it('returns notes with /alarm tags including all tags', () => {
    const noteWithAlarm = createNote(db, sqlite, {
      content: '# Alarm note',
      tags: [
        { tagType: '#', tagValue: '工作' },
        { tagType: '/alarm', tagValue: '2026-05-01T10:00:00' },
      ],
    });
    createNote(db, sqlite, {
      content: '# Normal note',
      tags: [{ tagType: '#', tagValue: '学习' }],
    });

    const result = listAlarmNotes(db, sqlite);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, noteWithAlarm.id);
    assert.equal(result[0].tags.length, 2);
  });

  it('excludes trashed notes', () => {
    const note = createNote(db, sqlite, {
      content: '# Trashed alarm',
      tags: [{ tagType: '/alarm', tagValue: '2026-05-01T10:00:00' }],
    });
    deleteNote(db, sqlite, note.id, { autoDeleteDays: 30 });

    const result = listAlarmNotes(db, sqlite);
    // Only the alarm note from the first test should remain
    assert.ok(result.every((n) => n.id !== note.id));
  });

  it('returns notes with multiple /alarm tags', () => {
    const note = createNote(db, sqlite, {
      content: '# Multi alarm',
      tags: [
        { tagType: '/alarm', tagValue: '2026-05-01T10:00:00' },
        { tagType: '/alarm', tagValue: '2026-06-01T10:00:00' },
        { tagType: '/weekly', tagValue: '' },
      ],
    });

    const result = listAlarmNotes(db, sqlite);
    const multiAlarm = result.find((n) => n.id === note.id);
    assert.ok(multiAlarm);
    assert.equal(multiAlarm.tags.length, 3);
  });
});

describe('search', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
    createNote(db, sqlite, { content: 'TypeScript programming tutorial' });
    createNote(db, sqlite, { content: 'Python machine learning guide' });
    createNote(db, sqlite, {
      content: 'JavaScript basics',
      tags: [{ tagType: '#', tagValue: 'coding' }],
    });
  });

  after(() => {
    sqlite.close();
  });

  it('searches by content', () => {
    const results = searchNotes(sqlite, 'programming');
    assert.equal(results.length, 1);
  });

  it('returns full notes with details', () => {
    const results = searchNotesWithDetails(db, sqlite, 'JavaScript');
    assert.equal(results.length, 1);
    assert.ok(results[0].tags.length > 0);
  });

  it('searches tags_text', () => {
    const results = searchNotes(sqlite, 'coding');
    assert.equal(results.length, 1);
  });

  it('returns empty for no match', () => {
    const results = searchNotes(sqlite, 'nonexistent_keyword_xyz');
    assert.equal(results.length, 0);
  });
});

// P3.4-a: pinnedFirst + sortBy='position' sort rules.
describe('listNotes — pin + position (P3.4-a)', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
    ensureSpecialNotes(db);
    // Drop special notes to keep assertions focused on our fixtures.
    sqlite.prepare('DELETE FROM notes').run();
    sqlite.prepare('DELETE FROM folders').run();
  });

  after(() => {
    sqlite.close();
  });

  /**
   * Raw INSERT so we control every field precisely — the public createNote()
   * stamps createdAt/updatedAt = now, which makes deterministic sort tests
   * painful to write.
   */
  function seed(opts: {
    id: string;
    folderId?: string | null;
    updatedAt: number;
    pinnedAt?: number | null;
    position?: number | null;
  }): void {
    sqlite
      .prepare(
        "INSERT INTO notes (id, folder_id, trash_level, created_at, updated_at, content, pinned_at, position, local_device_uuid) VALUES (?, ?, 0, ?, ?, ?, ?, ?, 'test-dev')",
      )
      .run(
        opts.id,
        opts.folderId ?? null,
        opts.updatedAt,
        opts.updatedAt,
        `# ${opts.id}`,
        opts.pinnedAt ?? null,
        opts.position ?? null,
      );
  }

  function resetFixture(): void {
    sqlite.prepare('DELETE FROM notes').run();
  }

  it('default (pinnedFirst=false) ignores pin status', () => {
    resetFixture();
    seed({ id: 'a', updatedAt: 100 });
    seed({ id: 'b', updatedAt: 200, pinnedAt: 9999 });
    seed({ id: 'c', updatedAt: 300 });

    const { items } = listNotes(db, sqlite, {});
    assert.deepEqual(
      items.map((n) => n.id),
      ['c', 'b', 'a'],
      'without pinnedFirst, order is plain updated_at DESC',
    );
  });

  it('pinnedFirst=true groups pinned notes above non-pinned; each group uses sort within', () => {
    resetFixture();
    seed({ id: 'a', updatedAt: 100 });
    seed({ id: 'b', updatedAt: 200, pinnedAt: 9999 });
    seed({ id: 'c', updatedAt: 300 });
    seed({ id: 'd', updatedAt: 400, pinnedAt: 8888 });

    const { items } = listNotes(db, sqlite, { pinnedFirst: true });
    // Pinned group (b, d) first by updated_at DESC → d, b;
    // Non-pinned group (a, c) next by updated_at DESC → c, a.
    assert.deepEqual(
      items.map((n) => n.id),
      ['d', 'b', 'c', 'a'],
    );
  });

  it('pinnedFirst respects sortOrder inside each group', () => {
    resetFixture();
    seed({ id: 'a', updatedAt: 100 });
    seed({ id: 'b', updatedAt: 200, pinnedAt: 9999 });
    seed({ id: 'c', updatedAt: 300 });
    seed({ id: 'd', updatedAt: 400, pinnedAt: 8888 });

    const { items } = listNotes(db, sqlite, { pinnedFirst: true, sortOrder: 'asc' });
    // Pinned ASC → b, d; non-pinned ASC → a, c.
    assert.deepEqual(
      items.map((n) => n.id),
      ['b', 'd', 'a', 'c'],
    );
  });

  it("sortBy='position' orders by position ASC NULLS LAST, updated_at DESC", () => {
    resetFixture();
    seed({ id: 'p1', updatedAt: 100, position: 1000 });
    seed({ id: 'p2', updatedAt: 200, position: 2000 });
    seed({ id: 'n1', updatedAt: 300 }); // null position
    seed({ id: 'n2', updatedAt: 400 }); // null position

    const { items } = listNotes(db, sqlite, { sortBy: 'position' });
    // Positioned rows first ascending; NULLs after, ordered by updated_at DESC.
    assert.deepEqual(
      items.map((n) => n.id),
      ['p1', 'p2', 'n2', 'n1'],
    );
  });

  it("sortBy='position' ignores sortOrder (semantics are fixed)", () => {
    resetFixture();
    seed({ id: 'p1', updatedAt: 100, position: 1000 });
    seed({ id: 'p2', updatedAt: 200, position: 2000 });

    const asc = listNotes(db, sqlite, { sortBy: 'position', sortOrder: 'asc' });
    const desc = listNotes(db, sqlite, { sortBy: 'position', sortOrder: 'desc' });
    assert.deepEqual(
      asc.items.map((n) => n.id),
      desc.items.map((n) => n.id),
      'position sort should not honour sortOrder',
    );
    assert.deepEqual(
      asc.items.map((n) => n.id),
      ['p1', 'p2'],
    );
  });

  it("pinnedFirst + sortBy='position' layers pin group over position order", () => {
    resetFixture();
    seed({ id: 'a', updatedAt: 100, position: 1000 });
    seed({ id: 'b', updatedAt: 200, position: 2000, pinnedAt: 9999 });
    seed({ id: 'c', updatedAt: 300, position: null });
    seed({ id: 'd', updatedAt: 400, position: null, pinnedAt: 8888 });

    const { items } = listNotes(db, sqlite, { pinnedFirst: true, sortBy: 'position' });
    // Pinned group (b, d): b has pos=2000, d has null → b then d (NULLS LAST + updated_at tie-break).
    // Non-pinned (a, c): a has pos=1000, c has null → a then c.
    assert.deepEqual(
      items.map((n) => n.id),
      ['b', 'd', 'a', 'c'],
    );
  });
});

describe('setNotePinned (P3.4-a)', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  after(() => {
    sqlite.close();
  });

  it('pin sets pinnedAt; unpin clears to null; does not touch updatedAt', async () => {
    const note = createNote(db, sqlite, { content: '# pin me' });
    const originalUpdatedAt = note.updatedAt.getTime();

    // Sleep a bit so that if updatedAt were wrongly bumped, the timestamp
    // difference would be observable.
    await new Promise((r) => setTimeout(r, 5));

    const pinnedAt = setNotePinned(db, sqlite, note.id, true);
    assert.ok(pinnedAt instanceof Date);

    const after = getNote(db, note.id);
    assert.ok(after?.pinnedAt);
    assert.equal(
      after.updatedAt.getTime(),
      originalUpdatedAt,
      'setNotePinned must NOT touch updated_at',
    );

    const cleared = setNotePinned(db, sqlite, note.id, false);
    assert.equal(cleared, null);
    const afterUnpin = getNote(db, note.id);
    assert.equal(afterUnpin?.pinnedAt, null);
    assert.equal(afterUnpin.updatedAt.getTime(), originalUpdatedAt);
  });

  it('throws on missing note', () => {
    assert.throws(() => setNotePinned(db, sqlite, 'nonexistent-id', true), /not found/);
  });
});

describe('reorderNotesInFolder (P3.4-a)', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
  });

  after(() => {
    sqlite.close();
  });

  function seedAt(id: string, folderId: string | null, updatedAt: number): void {
    sqlite
      .prepare(
        "INSERT INTO notes (id, folder_id, trash_level, created_at, updated_at, content, local_device_uuid) VALUES (?, ?, 0, ?, ?, ?, 'test-dev')",
      )
      .run(id, folderId, updatedAt, updatedAt, `# ${id}`);
  }

  function reset(): void {
    sqlite.prepare('DELETE FROM notes').run();
    sqlite.prepare('DELETE FROM folders').run();
  }

  it('writes positions 1000, 2000, 3000... and leaves updated_at untouched', () => {
    reset();
    seedAt('a', null, 100);
    seedAt('b', null, 200);
    seedAt('c', null, 300);

    reorderNotesInFolder(db, sqlite, null, ['c', 'a', 'b']);

    const rows = sqlite
      .prepare(
        'SELECT id, position, updated_at FROM notes WHERE folder_id IS NULL ORDER BY position',
      )
      .all() as { id: string; position: number; updated_at: number }[];
    assert.deepEqual(
      rows.map((r) => r.id),
      ['c', 'a', 'b'],
    );
    assert.deepEqual(
      rows.map((r) => r.position),
      [1000, 2000, 3000],
    );
    // Original updated_at values preserved
    const expected: Record<string, number> = { a: 100, b: 200, c: 300 };
    for (const r of rows) {
      assert.equal(r.updated_at, expected[r.id]);
    }
  });

  it('works for a concrete folder_id scope', () => {
    reset();
    sqlite
      .prepare(
        "INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, local_device_uuid) VALUES ('f1', 'F1', NULL, 0, 0, 0, 'test-dev')",
      )
      .run();
    seedAt('x', 'f1', 100);
    seedAt('y', 'f1', 200);
    seedAt('z', null, 300); // different scope — must be ignored

    reorderNotesInFolder(db, sqlite, 'f1', ['y', 'x']);

    const inF1 = sqlite
      .prepare('SELECT id, position FROM notes WHERE folder_id = ? ORDER BY position')
      .all('f1') as { id: string; position: number }[];
    assert.deepEqual(
      inF1.map((r) => r.id),
      ['y', 'x'],
    );
    // z (unfiled) should still have position = NULL
    const zRow = sqlite.prepare('SELECT position FROM notes WHERE id = ?').get('z') as {
      position: number | null;
    };
    assert.equal(zRow.position, null);
  });

  it('rejects duplicate ids', () => {
    reset();
    seedAt('a', null, 100);
    seedAt('b', null, 200);
    assert.throws(() => reorderNotesInFolder(db, sqlite, null, ['a', 'a']), /Duplicate id/);
  });

  it('rejects incomplete orderedIds (count mismatch)', () => {
    reset();
    seedAt('a', null, 100);
    seedAt('b', null, 200);
    seedAt('c', null, 300);
    assert.throws(
      () => reorderNotesInFolder(db, sqlite, null, ['a', 'b']),
      /length 2 does not match/,
    );
  });

  it('rejects ids outside the folder scope', () => {
    reset();
    sqlite
      .prepare(
        "INSERT INTO folders (id, name, parent_id, position, created_at, updated_at, local_device_uuid) VALUES ('f1', 'F1', NULL, 0, 0, 0, 'test-dev')",
      )
      .run();
    seedAt('x', 'f1', 100);
    seedAt('y', 'f1', 150); // second note in f1 so length check passes
    seedAt('z', null, 200); // outside f1
    // Length matches (2 == 2), but z doesn't belong to f1.
    assert.throws(() => reorderNotesInFolder(db, sqlite, 'f1', ['x', 'z']), /not in folder f1/);
  });

  it('rejects trashed notes (ordered ids must match trash_level=0 set)', () => {
    reset();
    seedAt('a', null, 100);
    seedAt('b', null, 200);
    sqlite.prepare('UPDATE notes SET trash_level = 1 WHERE id = ?').run('b');
    // The folder now has only `a` at trash_level=0; reorder with [a, b] includes a trashed note.
    assert.throws(
      () => reorderNotesInFolder(db, sqlite, null, ['a', 'b']),
      /length 2 does not match/,
    );
  });
});
