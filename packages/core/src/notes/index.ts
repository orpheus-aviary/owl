import type Database from 'better-sqlite3';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { updateFtsTagsText } from '../db/fts.js';
import type { OwlDatabase } from '../db/index.js';
import { noteTags, notes, tags } from '../db/schema.js';
import { SPECIAL_NOTES } from '../db/special-notes.js';
import { getFolderSubtreeIds } from '../folders/index.js';
import type { ParsedTag } from '../tags/parser.js';
import { AlreadyTrashedError, VersionMismatchError } from './errors.js';
import { contentHash } from './hash.js';

const SPECIAL_NOTE_IDS: ReadonlySet<string> = new Set(Object.values(SPECIAL_NOTES));

/** True for ids of system-managed notes that must never leave the list. */
function isSpecialNote(id: string): boolean {
  return SPECIAL_NOTE_IDS.has(id);
}

// ─── Types ─────────────────────────────────────────────

export interface NoteWithTags {
  id: string;
  content: string;
  folderId: string | null;
  trashLevel: number;
  createdAt: Date;
  updatedAt: Date;
  trashedAt: Date | null;
  autoDeleteAt: Date | null;
  deviceId: string | null;
  contentHash: string | null;
  tags: { id: string; tagType: string; tagValue: string | null }[];
}

export interface CreateNoteInput {
  content: string;
  folderId?: string | null;
  tags?: ParsedTag[];
  deviceId?: string;
}

export interface UpdateNoteInput {
  content?: string;
  folderId?: string | null;
  tags?: ParsedTag[];
  deviceId?: string;
}

/**
 * Options for write operations with optimistic concurrency control (CAS).
 * If `expectedUpdatedAt` is provided and the row's current `updated_at` in
 * milliseconds differs, the operation throws `VersionMismatchError` and
 * does not write.
 */
export interface UpdateNoteOptions {
  expectedUpdatedAt?: number;
}

export interface DeleteNoteOptions {
  /**
   * Days to add to `auto_delete_at` when a note crosses `trash_level=1 → 2`.
   * Level 0 → 1 transitions never stamp a deadline — the value is passed
   * through for signature stability. Daemon / GUI callers read this from
   * config.trash.auto_delete_days.
   */
  autoDeleteDays?: number;
  expectedUpdatedAt?: number;
  /**
   * When `true`, refuse to operate on a note already at `trash_level >= 1`
   * and throw `AlreadyTrashedError` instead. Default `false` preserves the
   * legacy level 1 → 2 upgrade path used by GUI TrashPage, batch delete,
   * and AI tools.
   */
  rejectIfTrashed?: boolean;
}

export interface RestoreNoteOptions {
  expectedUpdatedAt?: number;
}

export interface ListNotesOptions {
  q?: string;
  folderId?: string | null;
  /**
   * When `folderId` is a concrete id, whether to also include notes from
   * descendant folders (expanded via recursive CTE). Defaults to `true`.
   * Ignored when `folderId` is `null` (root/unfiled) or `undefined` (all).
   */
  includeDescendants?: boolean;
  trashLevel?: number;
  tagValues?: string[];
  sortBy?: 'updated' | 'created';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

// ─── CRUD ──────────────────────────────────────────────

export function createNote(
  db: OwlDatabase,
  sqlite: Database.Database,
  input: CreateNoteInput,
): NoteWithTags {
  const id = uuidv4();
  const now = new Date();
  const hash = contentHash(input.content);

  db.insert(notes)
    .values({
      id,
      content: input.content,
      folderId: input.folderId ?? null,
      createdAt: now,
      updatedAt: now,
      trashLevel: 0,
      deviceId: input.deviceId ?? null,
      contentHash: hash,
    })
    .run();

  if (input.tags?.length) {
    syncNoteTags(db, sqlite, id, input.tags);
  }

  // Safe: we just inserted this note
  const note = getNote(db, id);
  if (!note) throw new Error(`Failed to retrieve note after creation: ${id}`);
  return note;
}

export function getNote(db: OwlDatabase, id: string): NoteWithTags | null {
  const note = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!note) return null;

  const noteTags_ = db
    .select({
      id: tags.id,
      tagType: tags.tagType,
      tagValue: tags.tagValue,
    })
    .from(noteTags)
    .innerJoin(tags, eq(noteTags.tagId, tags.id))
    .where(eq(noteTags.noteId, id))
    .all();

  return { ...note, tags: noteTags_ };
}

export function listNotes(
  db: OwlDatabase,
  sqlite: Database.Database,
  options: ListNotesOptions = {},
): { items: NoteWithTags[]; total: number } {
  const {
    q,
    folderId,
    includeDescendants = true,
    trashLevel = 0,
    tagValues,
    page = 1,
    limit = 20,
    sortBy = 'updated',
    sortOrder = 'desc',
  } = options;
  const offset = (page - 1) * limit;

  let matchingIds: string[] | null = null;

  // FTS search (trigram requires >= 3 chars, fallback to LIKE)
  if (q) {
    if (q.length < 3) {
      const likeRows = sqlite
        .prepare('SELECT id FROM notes WHERE content LIKE ?')
        .all(`%${q}%`) as { id: string }[];
      matchingIds = likeRows.map((r) => r.id);
    } else {
      const ftsResults = sqlite
        .prepare('SELECT rowid FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank')
        .all(q) as { rowid: number }[];

      const rowids = ftsResults.map((r) => r.rowid);
      if (rowids.length === 0) return { items: [], total: 0 };

      const idRows = sqlite
        .prepare(`SELECT id FROM notes WHERE rowid IN (${rowids.map(() => '?').join(',')})`)
        .all(...rowids) as { id: string }[];

      matchingIds = idRows.map((r) => r.id);
    }
    if (matchingIds.length === 0) return { items: [], total: 0 };
  }

  // Tag filter (AND: notes must have ALL specified tags)
  if (tagValues?.length) {
    const tagRows = db
      .select({ noteId: noteTags.noteId, tagValue: tags.tagValue })
      .from(noteTags)
      .innerJoin(tags, eq(noteTags.tagId, tags.id))
      .where(and(eq(tags.tagType, '#'), inArray(tags.tagValue, tagValues)))
      .all();

    // Group by noteId and keep only those matching ALL requested tags
    const countByNote = new Map<string, number>();
    for (const row of tagRows) {
      countByNote.set(row.noteId, (countByNote.get(row.noteId) ?? 0) + 1);
    }
    const tagNoteIds = [...countByNote.entries()]
      .filter(([, count]) => count >= tagValues.length)
      .map(([noteId]) => noteId);
    if (tagNoteIds.length === 0) return { items: [], total: 0 };

    matchingIds = matchingIds ? matchingIds.filter((id) => tagNoteIds.includes(id)) : tagNoteIds;

    if (matchingIds.length === 0) return { items: [], total: 0 };
  }

  // Build conditions
  const conditions = [eq(notes.trashLevel, trashLevel)];

  if (folderId !== undefined) {
    if (folderId === null) {
      conditions.push(sql`${notes.folderId} IS NULL`);
    } else if (includeDescendants) {
      const subtreeIds = getFolderSubtreeIds(sqlite, folderId);
      if (subtreeIds.length === 0) return { items: [], total: 0 };
      conditions.push(inArray(notes.folderId, subtreeIds));
    } else {
      conditions.push(eq(notes.folderId, folderId));
    }
  }

  if (matchingIds) {
    conditions.push(inArray(notes.id, matchingIds));
  }

  const where = and(...conditions);

  // Count
  const countResult = db.select({ count: sql<number>`count(*)` }).from(notes).where(where).get();
  const total = countResult?.count ?? 0;

  // Fetch
  const orderCol = sortBy === 'created' ? notes.createdAt : notes.updatedAt;
  const orderDir = sortOrder === 'asc' ? sql`ASC` : sql`DESC`;

  const rows = db
    .select()
    .from(notes)
    .where(where)
    .orderBy(sql`${orderCol} ${orderDir}`)
    .limit(limit)
    .offset(offset)
    .all();

  const items = rows.map((note) => {
    const noteTags_ = db
      .select({ id: tags.id, tagType: tags.tagType, tagValue: tags.tagValue })
      .from(noteTags)
      .innerJoin(tags, eq(noteTags.tagId, tags.id))
      .where(eq(noteTags.noteId, note.id))
      .all();
    return { ...note, tags: noteTags_ };
  });

  return { items, total };
}

/** Return all non-trashed notes that have at least one /alarm tag, with full tags attached. */
export function listAlarmNotes(db: OwlDatabase, _sqlite: Database.Database): NoteWithTags[] {
  const alarmNoteIds = db
    .select({ noteId: noteTags.noteId })
    .from(noteTags)
    .innerJoin(tags, eq(noteTags.tagId, tags.id))
    .innerJoin(notes, eq(noteTags.noteId, notes.id))
    .where(and(eq(tags.tagType, '/alarm'), eq(notes.trashLevel, 0)))
    .all()
    .map((r) => r.noteId);

  if (alarmNoteIds.length === 0) return [];

  const uniqueIds = [...new Set(alarmNoteIds)];

  const rows = db.select().from(notes).where(inArray(notes.id, uniqueIds)).all();

  return rows.map((note) => {
    const noteTags_ = db
      .select({ id: tags.id, tagType: tags.tagType, tagValue: tags.tagValue })
      .from(noteTags)
      .innerJoin(tags, eq(noteTags.tagId, tags.id))
      .where(eq(noteTags.noteId, note.id))
      .all();
    return { ...note, tags: noteTags_ };
  });
}

export function updateNote(
  db: OwlDatabase,
  sqlite: Database.Database,
  id: string,
  input: UpdateNoteInput,
  opts?: UpdateNoteOptions,
): NoteWithTags | null {
  const run = sqlite.transaction(() => {
    const existing = db.select().from(notes).where(eq(notes.id, id)).get();
    if (!existing) return null;

    if (opts?.expectedUpdatedAt !== undefined) {
      const current = existing.updatedAt.getTime();
      if (current !== opts.expectedUpdatedAt) {
        throw new VersionMismatchError(id, opts.expectedUpdatedAt, current);
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (input.content !== undefined) {
      updates.content = input.content;
      updates.contentHash = contentHash(input.content);
    }
    if (input.folderId !== undefined) {
      updates.folderId = input.folderId;
    }
    if (input.deviceId !== undefined) {
      updates.deviceId = input.deviceId;
    }

    db.update(notes).set(updates).where(eq(notes.id, id)).run();

    if (input.tags !== undefined) {
      syncNoteTags(db, sqlite, id, input.tags);
    }

    return getNote(db, id);
  });
  return run.immediate() as NoteWithTags | null;
}

/**
 * Soft delete: increment trash_level. When a note enters level 2
 * ("即将清除"), stamp `auto_delete_at = now + opts.autoDeleteDays`. When it
 * enters level 1 the deadline stays NULL — auto-cleanup only targets level 2.
 *
 * Returns the updated note (with refreshed `updatedAt`). Returns `null` when
 * the id does not exist or points to a special note. Throws
 * `VersionMismatchError` on CAS failure and `AlreadyTrashedError` when
 * `rejectIfTrashed=true` and the current `trash_level >= 1`.
 */
export function deleteNote(
  db: OwlDatabase,
  sqlite: Database.Database,
  id: string,
  opts: DeleteNoteOptions = {},
): NoteWithTags | null {
  // System notes (memo / todo) are always pinned to the list; refuse both
  // soft and permanent deletion so AI tools and batch operations can't
  // strand them in the trash behind the user's back.
  if (isSpecialNote(id)) return null;

  const run = sqlite.transaction(() => {
    const note = db.select().from(notes).where(eq(notes.id, id)).get();
    if (!note) return null;

    if (opts.expectedUpdatedAt !== undefined) {
      const current = note.updatedAt.getTime();
      if (current !== opts.expectedUpdatedAt) {
        throw new VersionMismatchError(id, opts.expectedUpdatedAt, current);
      }
    }

    if (opts.rejectIfTrashed && note.trashLevel >= 1) {
      throw new AlreadyTrashedError(id, note.trashLevel);
    }

    const now = new Date();
    const newLevel = note.trashLevel + 1;
    const thresholdDays = opts.autoDeleteDays ?? 0;
    const autoDeleteAt =
      newLevel === 2 ? new Date(now.getTime() + thresholdDays * 86_400_000) : note.autoDeleteAt;

    db.update(notes)
      .set({
        trashLevel: newLevel,
        trashedAt: now,
        autoDeleteAt,
        updatedAt: now,
      })
      .where(eq(notes.id, id))
      .run();

    return getNote(db, id);
  });
  return run.immediate() as NoteWithTags | null;
}

/**
 * Restore: decrement trash_level. Clears `auto_delete_at` unconditionally.
 *
 * Returns the updated note. Returns `null` when the id does not exist or
 * the note is already at `trash_level=0`. Throws `VersionMismatchError`
 * on CAS failure.
 */
export function restoreNote(
  db: OwlDatabase,
  sqlite: Database.Database,
  id: string,
  opts: RestoreNoteOptions = {},
): NoteWithTags | null {
  const run = sqlite.transaction(() => {
    const note = db.select().from(notes).where(eq(notes.id, id)).get();
    if (!note || note.trashLevel === 0) return null;

    if (opts.expectedUpdatedAt !== undefined) {
      const current = note.updatedAt.getTime();
      if (current !== opts.expectedUpdatedAt) {
        throw new VersionMismatchError(id, opts.expectedUpdatedAt, current);
      }
    }

    const newLevel = note.trashLevel - 1;
    db.update(notes)
      .set({
        trashLevel: newLevel,
        trashedAt: newLevel === 0 ? null : note.trashedAt,
        autoDeleteAt: null,
        updatedAt: new Date(),
      })
      .where(eq(notes.id, id))
      .run();

    return getNote(db, id);
  });
  return run.immediate() as NoteWithTags | null;
}

/** Permanent delete */
export function permanentDeleteNote(db: OwlDatabase, id: string): boolean {
  if (isSpecialNote(id)) return false;
  const result = db.delete(notes).where(eq(notes.id, id)).run();
  return result.changes > 0;
}

/** Batch soft delete — see `deleteNote` for the `auto_delete_at` semantics. */
export function batchDeleteNotes(
  db: OwlDatabase,
  sqlite: Database.Database,
  ids: string[],
  autoDeleteDays: number,
): number {
  if (ids.length === 0) return 0;
  let count = 0;

  for (const id of ids) {
    if (deleteNote(db, sqlite, id, { autoDeleteDays })) count++;
  }

  return count;
}

/** Batch restore */
export function batchRestoreNotes(
  db: OwlDatabase,
  sqlite: Database.Database,
  ids: string[],
): number {
  if (ids.length === 0) return 0;
  let count = 0;

  for (const id of ids) {
    if (restoreNote(db, sqlite, id)) count++;
  }

  return count;
}

/** Batch permanent delete */
export function batchPermanentDeleteNotes(db: OwlDatabase, ids: string[]): number {
  if (ids.length === 0) return 0;
  let count = 0;

  for (const id of ids) {
    if (permanentDeleteNote(db, id)) count++;
  }

  return count;
}

// ─── Tag Sync ──────────────────────────────────────────

function syncNoteTags(
  db: OwlDatabase,
  sqlite: Database.Database,
  noteId: string,
  parsedTags: ParsedTag[],
): void {
  // Remove existing associations
  db.delete(noteTags).where(eq(noteTags.noteId, noteId)).run();

  // Upsert tags and create associations
  for (const pt of parsedTags) {
    // Find or create tag
    let tag = db
      .select()
      .from(tags)
      .where(and(eq(tags.tagType, pt.tagType), eq(tags.tagValue, pt.tagValue)))
      .get();

    if (!tag) {
      const tagId = uuidv4();
      db.insert(tags).values({ id: tagId, tagType: pt.tagType, tagValue: pt.tagValue }).run();
      tag = { id: tagId, tagType: pt.tagType, tagValue: pt.tagValue };
    }

    db.insert(noteTags).values({ noteId, tagId: tag.id }).onConflictDoNothing().run();
  }

  // Update FTS tags_text
  const noteRow = sqlite.prepare('SELECT rowid FROM notes WHERE id = ?').get(noteId) as
    | { rowid: number }
    | undefined;
  if (noteRow) {
    const hashTags = parsedTags.filter((t) => t.tagType === '#').map((t) => t.tagValue);
    updateFtsTagsText(sqlite, noteRow.rowid, hashTags.join(' '));
  }
}

export { contentHash } from './hash.js';
