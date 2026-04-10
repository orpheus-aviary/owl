import type Database from 'better-sqlite3';
import { and, eq, lte } from 'drizzle-orm';
import type { OwlDatabase } from '../db/index.js';
import { noteTags, notes, reminderStatus, tags } from '../db/schema.js';

// ─── Types ─────────────────────────────────────────────

export interface ReminderRecord {
  noteId: string;
  tagId: string;
  fireAt: number;
  status: string;
  firedAt: number | null;
}

// ─── Helpers ───────────────────────────────────────────

/** Zero out seconds and milliseconds from a Unix-ms timestamp. */
export function normalizeFireAt(unixMs: number): number {
  const d = new Date(unixMs);
  d.setSeconds(0, 0);
  return d.getTime();
}

/** Parse an ISO date string tag value to normalized Unix ms. */
function tagValueToFireAt(tagValue: string): number {
  const ms = new Date(tagValue).getTime();
  return normalizeFireAt(ms);
}

// ─── Sync ──────────────────────────────────────────────

/**
 * Sync reminder_status for a note based on its current /alarm tags.
 * - Inserts pending for new alarm tags
 * - Deletes records for removed tags
 * - Updates fire_at + resets to pending if time changed
 * - Leaves fired records alone if time hasn't changed
 */
export function syncReminders(db: OwlDatabase, _sqlite: Database.Database, noteId: string): void {
  // 1. Get current /alarm tags for this note
  const alarmTags = db
    .select({ tagId: noteTags.tagId, tagValue: tags.tagValue })
    .from(noteTags)
    .innerJoin(tags, eq(noteTags.tagId, tags.id))
    .where(and(eq(noteTags.noteId, noteId), eq(tags.tagType, '/alarm')))
    .all();

  // 2. Get existing reminder_status records for this note
  const existing = db.select().from(reminderStatus).where(eq(reminderStatus.noteId, noteId)).all();

  const alarmTagIds = new Set(alarmTags.map((t) => t.tagId));
  const existingByTagId = new Map(existing.map((r) => [r.tagId, r]));

  // 3. Delete records for tags that no longer exist
  for (const record of existing) {
    if (!alarmTagIds.has(record.tagId)) {
      db.delete(reminderStatus)
        .where(and(eq(reminderStatus.noteId, noteId), eq(reminderStatus.tagId, record.tagId)))
        .run();
    }
  }

  // 4. Insert or update for current alarm tags
  for (const alarm of alarmTags) {
    const fireAt = tagValueToFireAt(alarm.tagValue ?? '');
    const record = existingByTagId.get(alarm.tagId);

    if (!record) {
      // New alarm tag — insert pending
      db.insert(reminderStatus)
        .values({ noteId, tagId: alarm.tagId, fireAt, status: 'pending', firedAt: null })
        .run();
    } else if (record.fireAt !== fireAt) {
      // Time changed — update fire_at and reset to pending
      db.update(reminderStatus)
        .set({ fireAt, status: 'pending', firedAt: null })
        .where(and(eq(reminderStatus.noteId, noteId), eq(reminderStatus.tagId, alarm.tagId)))
        .run();
    }
    // else: time unchanged — leave as-is (including fired records)
  }
}

// ─── Queries ───────────────────────────────────────────

/** All pending reminders ordered by fire_at ASC. */
export function getPendingReminders(db: OwlDatabase): ReminderRecord[] {
  return db
    .select()
    .from(reminderStatus)
    .where(eq(reminderStatus.status, 'pending'))
    .orderBy(reminderStatus.fireAt)
    .all();
}

/** Pending reminders where fire_at <= now. */
export function getOverdueReminders(db: OwlDatabase, now?: number): ReminderRecord[] {
  const cutoff = now ?? Date.now();
  return db
    .select()
    .from(reminderStatus)
    .where(and(eq(reminderStatus.status, 'pending'), lte(reminderStatus.fireAt, cutoff)))
    .orderBy(reminderStatus.fireAt)
    .all();
}

/** Earliest pending reminder (LIMIT 1). */
export function getNextPendingReminder(db: OwlDatabase): ReminderRecord | null {
  return (
    db
      .select()
      .from(reminderStatus)
      .where(eq(reminderStatus.status, 'pending'))
      .orderBy(reminderStatus.fireAt)
      .limit(1)
      .get() ?? null
  );
}

/** Update status to 'fired' with timestamp. */
export function markFired(db: OwlDatabase, noteId: string, tagId: string, firedAt: number): void {
  db.update(reminderStatus)
    .set({ status: 'fired', firedAt })
    .where(and(eq(reminderStatus.noteId, noteId), eq(reminderStatus.tagId, tagId)))
    .run();
}

// ─── Utilities ─────────────────────────────────────────

/** First non-empty line of note content, or 'Untitled'. */
export function getNoteTitle(db: OwlDatabase, noteId: string): string {
  const note = db.select({ content: notes.content }).from(notes).where(eq(notes.id, noteId)).get();
  if (!note) return 'Untitled';

  const lines = note.content.split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed) return trimmed;
  }
  return 'Untitled';
}

/**
 * Permanently delete notes with trash_level=2 and trashedAt older than `days` days.
 * Returns count of deleted notes.
 */
export function cleanupExpiredTrash(
  db: OwlDatabase,
  _sqlite: Database.Database,
  days: number,
): number {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const expired = db
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.trashLevel, 2), lte(notes.trashedAt, cutoff)))
    .all();

  if (expired.length === 0) return 0;

  for (const row of expired) {
    db.delete(notes).where(eq(notes.id, row.id)).run();
  }

  return expired.length;
}
