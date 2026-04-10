import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import type { OwlDatabase } from '../db/index.js';
import { createNote, updateNote } from '../notes/index.js';
import {
  cleanupExpiredTrash,
  getNextPendingReminder,
  getOverdueReminders,
  getPendingReminders,
  markFired,
  normalizeFireAt,
  syncReminders,
} from './index.js';

describe('normalizeFireAt', () => {
  it('zeroes seconds and milliseconds', () => {
    // 2026-05-01T10:30:45.123Z
    const input = new Date('2026-05-01T10:30:45.123Z').getTime();
    const result = normalizeFireAt(input);
    const d = new Date(result);
    assert.equal(d.getUTCSeconds(), 0);
    assert.equal(d.getUTCMilliseconds(), 0);
    assert.equal(d.getUTCMinutes(), 30);
    assert.equal(d.getUTCHours(), 10);
  });
});

describe('syncReminders', () => {
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

  it('creates pending record when note has /alarm tag', () => {
    const note = createNote(db, sqlite, {
      content: '# Alarm test',
      tags: [{ tagType: '/alarm', tagValue: '2026-05-01T10:00:00' }],
    });

    syncReminders(db, sqlite, note.id);

    const pending = getPendingReminders(db);
    const match = pending.find((r) => r.noteId === note.id);
    assert.ok(match);
    assert.equal(match.status, 'pending');
    assert.equal(match.fireAt, normalizeFireAt(new Date('2026-05-01T10:00:00').getTime()));
  });

  it('removes reminder when /alarm tag is deleted', () => {
    const note = createNote(db, sqlite, {
      content: '# Will remove alarm',
      tags: [{ tagType: '/alarm', tagValue: '2026-06-01T09:00:00' }],
    });

    syncReminders(db, sqlite, note.id);
    let pending = getPendingReminders(db);
    assert.ok(pending.some((r) => r.noteId === note.id));

    // Remove all tags
    updateNote(db, sqlite, note.id, { tags: [] });
    syncReminders(db, sqlite, note.id);

    pending = getPendingReminders(db);
    assert.ok(!pending.some((r) => r.noteId === note.id));
  });

  it('updates fire_at when alarm time changes', () => {
    const note = createNote(db, sqlite, {
      content: '# Time change',
      tags: [{ tagType: '/alarm', tagValue: '2026-07-01T08:00:00' }],
    });

    syncReminders(db, sqlite, note.id);

    // Change the alarm time
    updateNote(db, sqlite, note.id, {
      tags: [{ tagType: '/alarm', tagValue: '2026-07-01T14:00:00' }],
    });
    syncReminders(db, sqlite, note.id);

    const pending = getPendingReminders(db);
    const match = pending.find((r) => r.noteId === note.id);
    assert.ok(match);
    assert.equal(match.fireAt, normalizeFireAt(new Date('2026-07-01T14:00:00').getTime()));
  });

  it('ignores /time tags (only tracks /alarm)', () => {
    const note = createNote(db, sqlite, {
      content: '# Time tag test',
      tags: [{ tagType: '/time', tagValue: '2026-08-01T10:00:00' }],
    });

    syncReminders(db, sqlite, note.id);

    const pending = getPendingReminders(db);
    assert.ok(!pending.some((r) => r.noteId === note.id));
  });
});

describe('markFired', () => {
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

  it('updates status to fired with timestamp', () => {
    const note = createNote(db, sqlite, {
      content: '# Fire me',
      tags: [{ tagType: '/alarm', tagValue: '2026-05-01T10:00:00' }],
    });

    syncReminders(db, sqlite, note.id);

    const pending = getPendingReminders(db);
    const match = pending.find((r) => r.noteId === note.id);
    assert.ok(match);

    const firedAt = Date.now();
    markFired(db, match.noteId, match.tagId, firedAt);

    const next = getNextPendingReminder(db);
    // Should not appear in pending anymore
    assert.ok(!next || next.noteId !== note.id);

    // Verify via overdue (should not appear either)
    const overdue = getOverdueReminders(db, Date.now() + 1000 * 60 * 60 * 24 * 365 * 10);
    assert.ok(!overdue.some((r) => r.noteId === note.id));
  });
});

describe('cleanupExpiredTrash', () => {
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

  it('deletes notes trashed over N days ago', () => {
    const note = createNote(db, sqlite, { content: '# Old trash' });
    const noteId = note.id;

    // Set trash_level=2 and trashedAt to 40 days ago via raw SQL
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    sqlite
      .prepare('UPDATE notes SET trash_level = 2, trashed_at = ? WHERE id = ?')
      .run(fortyDaysAgo, noteId);

    const count = cleanupExpiredTrash(db, sqlite, 30);
    assert.equal(count, 1);

    // Verify note is gone
    const row = sqlite.prepare('SELECT id FROM notes WHERE id = ?').get(noteId);
    assert.equal(row, undefined);
  });

  it('does not delete recently trashed notes', () => {
    const note = createNote(db, sqlite, { content: '# Recent trash' });
    const noteId = note.id;

    // Set trash_level=2 and trashedAt to 5 days ago
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    sqlite
      .prepare('UPDATE notes SET trash_level = 2, trashed_at = ? WHERE id = ?')
      .run(fiveDaysAgo, noteId);

    const count = cleanupExpiredTrash(db, sqlite, 30);
    assert.equal(count, 0);

    // Verify note still exists
    const row = sqlite.prepare('SELECT id FROM notes WHERE id = ?').get(noteId) as
      | { id: string }
      | undefined;
    assert.ok(row);
    assert.equal(row.id, noteId);
  });
});
