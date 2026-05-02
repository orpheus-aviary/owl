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
  restoreNote,
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
    assert.ok(permanentDeleteNote(db, note.id));
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
    assert.equal(permanentDeleteNote(db, MEMO), false);
    assert.equal(permanentDeleteNote(db, TODO), false);
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
