import type Database from 'better-sqlite3';
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
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

// ─── Status-aware listing (used by AI tool `get_reminders`) ────────────

export interface ReminderWithNote {
  noteId: string;
  noteTitle: string;
  noteContent: string;
  tagId: string;
  fireAt: number;
  /** 'pending' | 'fired' | 'overdue' (computed from pending + fireAt <= now). */
  status: 'pending' | 'fired' | 'overdue';
  firedAt: number | null;
}

export interface ListRemindersOptions {
  /**
   * - 'pending' → status='pending' AND fireAt > now
   * - 'overdue' → status='pending' AND fireAt <= now
   * - 'fired'   → status='fired'
   * - undefined → all
   */
  status?: 'pending' | 'fired' | 'overdue';
  /** Inclusive lower bound (Unix ms). */
  from?: number;
  /** Inclusive upper bound (Unix ms). */
  to?: number;
  limit?: number;
  /** When omitted, defaults to Date.now() — overridable for deterministic tests. */
  now?: number;
}

/**
 * Authoritative status-aware reminder listing.
 *
 * Joins `reminder_status` (the source of truth for fire/pending state) with
 * `notes` so callers get titles and content alongside scheduling fields.
 * Trashed notes are excluded.
 *
 * Implementation note: written with raw SQL because drizzle's typed builder
 * has no clean way to express the `(status='pending' AND fireAt <= now)`
 * disjunction needed for the 'overdue' bucket alongside trash filtering.
 */
export function listRemindersWithStatus(
  _db: OwlDatabase,
  sqlite: Database.Database,
  options: ListRemindersOptions = {},
): ReminderWithNote[] {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 50;

  const conditions: string[] = ['n.trash_level = 0'];
  const params: Array<string | number> = [];

  if (options.status === 'pending') {
    conditions.push('rs.status = ?', 'rs.fire_at > ?');
    params.push('pending', now);
  } else if (options.status === 'overdue') {
    conditions.push('rs.status = ?', 'rs.fire_at <= ?');
    params.push('pending', now);
  } else if (options.status === 'fired') {
    conditions.push('rs.status = ?');
    params.push('fired');
  }

  if (options.from !== undefined) {
    conditions.push('rs.fire_at >= ?');
    params.push(options.from);
  }
  if (options.to !== undefined) {
    conditions.push('rs.fire_at <= ?');
    params.push(options.to);
  }

  params.push(limit);

  const rows = sqlite
    .prepare(
      `SELECT
         rs.note_id     AS noteId,
         rs.tag_id      AS tagId,
         rs.fire_at     AS fireAt,
         rs.status      AS rawStatus,
         rs.fired_at    AS firedAt,
         n.content      AS noteContent
       FROM reminder_status rs
       JOIN notes n ON n.id = rs.note_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY rs.fire_at ASC
       LIMIT ?`,
    )
    .all(...params) as Array<{
    noteId: string;
    tagId: string;
    fireAt: number;
    rawStatus: string;
    firedAt: number | null;
    noteContent: string;
  }>;

  return rows.map((r) => ({
    noteId: r.noteId,
    noteTitle: deriveTitle(r.noteContent),
    noteContent: r.noteContent,
    tagId: r.tagId,
    fireAt: r.fireAt,
    status: computeStatus(r.rawStatus, r.fireAt, now),
    firedAt: r.firedAt,
  }));
}

function computeStatus(
  rawStatus: string,
  fireAt: number,
  now: number,
): 'pending' | 'fired' | 'overdue' {
  if (rawStatus === 'fired') return 'fired';
  return fireAt <= now ? 'overdue' : 'pending';
}

function deriveTitle(content: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed) return trimmed;
  }
  return 'Untitled';
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
 * Permanently delete level-2 trash notes whose sticky `auto_delete_at`
 * deadline has passed. Returns the number of deletions.
 */
export function cleanupExpiredTrash(db: OwlDatabase, _sqlite: Database.Database): number {
  const now = new Date();

  const expired = db
    .select({ id: notes.id })
    .from(notes)
    .where(
      and(eq(notes.trashLevel, 2), isNotNull(notes.autoDeleteAt), lte(notes.autoDeleteAt, now)),
    )
    .all();

  if (expired.length === 0) return 0;

  for (const row of expired) {
    db.delete(notes).where(eq(notes.id, row.id)).run();
  }

  return expired.length;
}

/**
 * Recompute `auto_delete_at` for all level-2 trash notes given the current
 * threshold. The deadline is monotonically non-increasing:
 *
 *   new_deadline = min(existing_deadline, now + thresholdDays)
 *
 * - Lowering the threshold pulls deadlines earlier.
 * - Raising the threshold leaves existing deadlines untouched.
 * - Notes that somehow ended up in level 2 with NULL (pre-migration data)
 *   are treated as if their deadline were infinity and get stamped.
 */
export function recomputeTrashDeadlines(db: OwlDatabase, thresholdDays: number): number {
  const ceiling = Date.now() + thresholdDays * 86_400_000;

  const result = db
    .update(notes)
    .set({
      autoDeleteAt: sql`MIN(COALESCE(${notes.autoDeleteAt}, ${ceiling}), ${ceiling})`,
    })
    .where(eq(notes.trashLevel, 2))
    .run();

  return result.changes;
}

/**
 * Return the earliest pending `auto_delete_at` timestamp (ms) across all
 * level-2 trash notes, or `null` if none exist. Used by the scheduler to
 * arm its next cleanup timer.
 */
export function getNextTrashDeadline(db: OwlDatabase): number | null {
  const row = db
    .select({ deadline: sql<number>`MIN(${notes.autoDeleteAt})` })
    .from(notes)
    .where(and(eq(notes.trashLevel, 2), isNotNull(notes.autoDeleteAt)))
    .get();
  return row?.deadline ?? null;
}
