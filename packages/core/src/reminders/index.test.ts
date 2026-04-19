import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import type { OwlDatabase } from '../db/index.js';
import { reminderStatus } from '../db/schema.js';
import { createNote, updateNote } from '../notes/index.js';
import {
  cleanupExpiredTrash,
  cleanupOldFiredReminders,
  getNextPendingReminder,
  getNextTrashDeadline,
  getOverdueReminders,
  getPendingReminders,
  markFired,
  normalizeFireAt,
  recomputeTrashDeadlines,
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

  it('deletes level-2 notes with auto_delete_at in the past', () => {
    const note = createNote(db, sqlite, { content: '# Old trash' });
    const noteId = note.id;

    // Put it into level 2 with an already-passed deadline
    const pastDeadline = Date.now() - 60_000;
    sqlite
      .prepare('UPDATE notes SET trash_level = 2, auto_delete_at = ? WHERE id = ?')
      .run(pastDeadline, noteId);

    const count = cleanupExpiredTrash(db, sqlite);
    assert.equal(count, 1);

    const row = sqlite.prepare('SELECT id FROM notes WHERE id = ?').get(noteId);
    assert.equal(row, undefined);
  });

  it('does not delete level-2 notes with a future deadline', () => {
    const note = createNote(db, sqlite, { content: '# Recent trash' });
    const noteId = note.id;

    const future = Date.now() + 10 * 86_400_000;
    sqlite
      .prepare('UPDATE notes SET trash_level = 2, auto_delete_at = ? WHERE id = ?')
      .run(future, noteId);

    const count = cleanupExpiredTrash(db, sqlite);
    assert.equal(count, 0);

    const row = sqlite.prepare('SELECT id FROM notes WHERE id = ?').get(noteId) as
      | { id: string }
      | undefined;
    assert.ok(row);
  });

  it('ignores level-2 notes with NULL auto_delete_at (pre-migration data)', () => {
    const note = createNote(db, sqlite, { content: '# Legacy trash' });
    sqlite
      .prepare('UPDATE notes SET trash_level = 2, auto_delete_at = NULL WHERE id = ?')
      .run(note.id);

    const count = cleanupExpiredTrash(db, sqlite);
    assert.equal(count, 0);
  });
});

describe('recomputeTrashDeadlines', () => {
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

  function putInLevel2(noteId: string, deadline: number | null): void {
    sqlite
      .prepare('UPDATE notes SET trash_level = 2, auto_delete_at = ? WHERE id = ?')
      .run(deadline, noteId);
  }

  function readDeadline(noteId: string): number | null {
    const row = sqlite.prepare('SELECT auto_delete_at FROM notes WHERE id = ?').get(noteId) as
      | { auto_delete_at: number | null }
      | undefined;
    return row?.auto_delete_at ?? null;
  }

  it('lowering threshold pulls deadlines earlier', () => {
    const note = createNote(db, sqlite, { content: '# Pull in' });
    // Start with a far-out deadline, like threshold was 30
    putInLevel2(note.id, Date.now() + 30 * 86_400_000);

    recomputeTrashDeadlines(db, 7);
    const d = readDeadline(note.id);
    assert.ok(d);
    // Should be ~now + 7d, not 30d
    const now = Date.now();
    assert.ok(d <= now + 7 * 86_400_000 + 1000);
    assert.ok(d >= now + 7 * 86_400_000 - 5000);
  });

  it('raising threshold does not extend existing deadlines', () => {
    const note = createNote(db, sqlite, { content: '# Stay put' });
    // Note has a 5-day deadline already
    const shortDeadline = Date.now() + 5 * 86_400_000;
    putInLevel2(note.id, shortDeadline);

    recomputeTrashDeadlines(db, 30);
    const d = readDeadline(note.id);
    // Must remain ≈ shortDeadline, not jump to 30 days
    assert.equal(d, shortDeadline);
  });

  it('null deadline (legacy row) gets stamped with the current threshold', () => {
    const note = createNote(db, sqlite, { content: '# Legacy' });
    putInLevel2(note.id, null);

    recomputeTrashDeadlines(db, 14);
    const d = readDeadline(note.id);
    assert.ok(d);
    const expected = Date.now() + 14 * 86_400_000;
    assert.ok(Math.abs((d ?? 0) - expected) < 5000);
  });

  it('user scenario: 30 → 7 → wait 1d → 30 keeps the 6-day remaining', () => {
    const note = createNote(db, sqlite, { content: '# Scenario' });
    // Start with a 30-day deadline
    const t0 = Date.now();
    putInLevel2(note.id, t0 + 30 * 86_400_000);

    // Lower to 7 — deadline should come in
    recomputeTrashDeadlines(db, 7);
    const d1 = readDeadline(note.id);
    assert.ok(d1 && d1 <= t0 + 7 * 86_400_000 + 1000);

    // Simulate "one day has passed" — bump the deadline back one day so our
    // recompute sees it as if we'd gone through a real day.
    const simulatedDeadline = (d1 ?? 0) - 86_400_000;
    sqlite
      .prepare('UPDATE notes SET auto_delete_at = ? WHERE id = ?')
      .run(simulatedDeadline, note.id);

    // Raise back to 30 — deadline must NOT move
    recomputeTrashDeadlines(db, 30);
    const d2 = readDeadline(note.id);
    assert.equal(d2, simulatedDeadline);
  });
});

describe('getNextTrashDeadline', () => {
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

  it('returns null when no level-2 notes exist', () => {
    assert.equal(getNextTrashDeadline(db), null);
  });

  it('returns the earliest non-null deadline', () => {
    const a = createNote(db, sqlite, { content: '# A' });
    const b = createNote(db, sqlite, { content: '# B' });
    const c = createNote(db, sqlite, { content: '# C — no deadline' });

    const t = Date.now();
    sqlite
      .prepare('UPDATE notes SET trash_level = 2, auto_delete_at = ? WHERE id = ?')
      .run(t + 100_000, a.id);
    sqlite
      .prepare('UPDATE notes SET trash_level = 2, auto_delete_at = ? WHERE id = ?')
      .run(t + 50_000, b.id);
    sqlite
      .prepare('UPDATE notes SET trash_level = 2, auto_delete_at = NULL WHERE id = ?')
      .run(c.id);

    assert.equal(getNextTrashDeadline(db), t + 50_000);
  });
});

describe('cleanupOldFiredReminders', () => {
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

  it('deletes fired rows older than retention; keeps recent fired + all pending', () => {
    const day = 86_400_000;
    const now = Date.now();

    // Four alarm-bearing notes. After syncReminders each has a pending row;
    // we then mutate status / fired_at directly to cover all four classes.
    const old = createNote(db, sqlite, {
      content: '# old fired',
      tags: [{ tagType: '/alarm', tagValue: '2024-01-01T10:00:00' }],
    });
    const recent = createNote(db, sqlite, {
      content: '# recent fired',
      tags: [{ tagType: '/alarm', tagValue: '2024-02-01T10:00:00' }],
    });
    const pending = createNote(db, sqlite, {
      content: '# future pending',
      tags: [{ tagType: '/alarm', tagValue: '2027-01-01T10:00:00' }],
    });
    const overdue = createNote(db, sqlite, {
      content: '# overdue but never fired',
      tags: [{ tagType: '/alarm', tagValue: '2024-03-01T10:00:00' }],
    });
    syncReminders(db, sqlite, old.id);
    syncReminders(db, sqlite, recent.id);
    syncReminders(db, sqlite, pending.id);
    syncReminders(db, sqlite, overdue.id);

    sqlite
      .prepare('UPDATE reminder_status SET status = ?, fired_at = ? WHERE note_id = ?')
      .run('fired', now - 100 * day, old.id);
    sqlite
      .prepare('UPDATE reminder_status SET status = ?, fired_at = ? WHERE note_id = ?')
      .run('fired', now - 30 * day, recent.id);
    // pending + overdue rows stay pending with firedAt NULL.

    const purged = cleanupOldFiredReminders(db, 90);
    assert.equal(purged, 1);

    const remaining = db
      .select({ id: reminderStatus.noteId })
      .from(reminderStatus)
      .all()
      .map((r) => r.id)
      .sort();
    assert.deepEqual(remaining, [recent.id, pending.id, overdue.id].sort());
  });

  it('returns 0 when nothing exceeds retention', () => {
    const { db: db2, sqlite: sqlite2 } = createDatabase({ dbPath: ':memory:' });
    const n = createNote(db2, sqlite2, {
      content: '# fresh',
      tags: [{ tagType: '/alarm', tagValue: '2026-01-01T10:00:00' }],
    });
    syncReminders(db2, sqlite2, n.id);
    sqlite2
      .prepare('UPDATE reminder_status SET status = ?, fired_at = ? WHERE note_id = ?')
      .run('fired', Date.now() - 10 * 86_400_000, n.id);

    assert.equal(cleanupOldFiredReminders(db2, 90), 0);
    sqlite2.close();
  });
});
