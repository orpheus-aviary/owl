import type Database from 'better-sqlite3';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { updateFtsTagsText } from '../db/fts.js';
import type { OwlDatabase } from '../db/index.js';
import { noteTags, notes, tags } from '../db/schema.js';
import type { ParsedTag } from '../tags/parser.js';
import { contentHash } from './hash.js';

// ─── Types ─────────────────────────────────────────────

export interface NoteWithTags {
  id: string;
  content: string;
  folderId: string | null;
  trashLevel: number;
  createdAt: Date;
  updatedAt: Date;
  trashedAt: Date | null;
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

export interface ListNotesOptions {
  q?: string;
  folderId?: string | null;
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
    conditions.push(
      folderId === null ? sql`${notes.folderId} IS NULL` : eq(notes.folderId, folderId),
    );
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

export function updateNote(
  db: OwlDatabase,
  sqlite: Database.Database,
  id: string,
  input: UpdateNoteInput,
): NoteWithTags | null {
  const existing = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!existing) return null;

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
}

/** Soft delete: increment trash_level */
export function deleteNote(db: OwlDatabase, id: string): boolean {
  const note = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!note) return false;

  db.update(notes)
    .set({
      trashLevel: note.trashLevel + 1,
      trashedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(notes.id, id))
    .run();

  return true;
}

/** Restore: decrement trash_level */
export function restoreNote(db: OwlDatabase, id: string): boolean {
  const note = db.select().from(notes).where(eq(notes.id, id)).get();
  if (!note || note.trashLevel === 0) return false;

  const newLevel = note.trashLevel - 1;
  db.update(notes)
    .set({
      trashLevel: newLevel,
      trashedAt: newLevel === 0 ? null : note.trashedAt,
      updatedAt: new Date(),
    })
    .where(eq(notes.id, id))
    .run();

  return true;
}

/** Permanent delete */
export function permanentDeleteNote(db: OwlDatabase, id: string): boolean {
  const result = db.delete(notes).where(eq(notes.id, id)).run();
  return result.changes > 0;
}

/** Batch soft delete */
export function batchDeleteNotes(db: OwlDatabase, ids: string[]): number {
  if (ids.length === 0) return 0;
  const now = new Date();
  let count = 0;

  for (const id of ids) {
    const note = db.select().from(notes).where(eq(notes.id, id)).get();
    if (note) {
      db.update(notes)
        .set({ trashLevel: note.trashLevel + 1, trashedAt: now, updatedAt: now })
        .where(eq(notes.id, id))
        .run();
      count++;
    }
  }

  return count;
}

/** Batch restore */
export function batchRestoreNotes(db: OwlDatabase, ids: string[]): number {
  if (ids.length === 0) return 0;
  let count = 0;

  for (const id of ids) {
    if (restoreNote(db, id)) count++;
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
