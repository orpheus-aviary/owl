import type Database from 'better-sqlite3';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { OwlDatabase } from '../db/index.js';
import { noteTags, notes, tags } from '../db/schema.js';
import { SPECIAL_NOTES } from '../db/special-notes.js';
import { getFolderSubtreeIds } from '../folders/index.js';
import { syncReminders } from '../reminders/index.js';
import { readSkybridgeDeviceId } from '../skybridge/identity.js';
import { emitSyncChange, readLocalDeviceUuid } from '../sync/changes.js';
import type { ParsedTag } from '../tags/parser.js';
import { AlreadyTrashedError, VersionMismatchError } from './errors.js';
import { contentHash } from './hash.js';
import { syncNoteTags } from './tags.js';

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
  pinnedAt: Date | null;
  position: number | null;
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
  /**
   * `'updated'` / `'created'` — order by the matching timestamp column.
   * `'position'` — order by the per-folder manual sort key: `position ASC NULLS LAST, updated_at DESC`.
   *                `sortOrder` is ignored for `'position'` (semantics are fixed).
   */
  sortBy?: 'updated' | 'created' | 'position';
  sortOrder?: 'asc' | 'desc';
  /**
   * When `true`, pinned notes (`pinned_at IS NOT NULL`) come first as a
   * distinct group, with the chosen `sortBy`/`sortOrder` applied independently
   * inside each group (pinned and non-pinned). Default `false` — pin status
   * does not influence ordering (used by AI tools / legacy callers).
   */
  pinnedFirst?: boolean;
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
  const nowMs = now.getTime();
  const hash = contentHash(input.content);

  return sqlite
    .transaction(() => {
      db.insert(notes)
        .values({
          id,
          content: input.content,
          folderId: input.folderId ?? null,
          createdAt: now,
          updatedAt: now,
          trashLevel: 0,
          deviceId: input.deviceId ?? readSkybridgeDeviceId(sqlite) ?? null,
          contentHash: hash,
          localDeviceUuid: readLocalDeviceUuid(sqlite),
        })
        .run();

      if (input.tags?.length) {
        syncNoteTags(db, sqlite, id, input.tags);
        // P5-c G5: stamp reminder_status atomically with the note + tags
        // write so /alarm tags fire from the next scheduler tick without
        // needing the daemon ReminderScheduler poll to catch up. Daemon
        // scheduler.onNoteChanged() still runs syncReminders (idempotent)
        // + scheduleNext() to refresh the in-memory timer.
        syncReminders(db, sqlite, id);
      }

      emitSyncChange(sqlite, {
        entityType: 'note',
        entityId: id,
        op: 'create',
        payload: {
          content: input.content,
          folder_id: input.folderId ?? null,
          trash_level: 0,
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
          tags: (input.tags ?? []).map((t) => ({ tag_type: t.tagType, tag_value: t.tagValue })),
        },
        nowMs,
      });

      // Safe: we just inserted this note
      const note = getNote(db, id);
      if (!note) throw new Error(`Failed to retrieve note after creation: ${id}`);
      return note;
    })
    .immediate();
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
    pinnedFirst = false,
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
  //
  // Ordering semantics:
  //   pinnedFirst=true  → `(pinned_at IS NULL) ASC` groups pinned rows (0)
  //                       before non-pinned rows (1); in-group ordering falls
  //                       through to the sortBy/sortOrder clauses below
  //   sortBy='position' → `position ASC NULLS LAST, updated_at DESC`
  //                       (sortOrder is ignored — semantics fixed per design)
  //   sortBy='updated' | 'created' + sortOrder → conventional column sort
  const dir = sortOrder === 'asc' ? sql`ASC` : sql`DESC`;
  const groupClause = pinnedFirst ? sql`(${notes.pinnedAt} IS NULL) ASC, ` : sql``;
  const mainClause =
    sortBy === 'position'
      ? sql`${notes.position} ASC NULLS LAST, ${notes.updatedAt} DESC`
      : sortBy === 'created'
        ? sql`${notes.createdAt} ${dir}`
        : sql`${notes.updatedAt} ${dir}`;

  const rows = db
    .select()
    .from(notes)
    .where(where)
    .orderBy(sql`${groupClause}${mainClause}`)
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

    const now = new Date();
    const nowMs = now.getTime();
    const updates: Record<string, unknown> = { updatedAt: now };

    if (input.content !== undefined) {
      updates.content = input.content;
      updates.contentHash = contentHash(input.content);
    }
    if (input.folderId !== undefined) {
      updates.folderId = input.folderId;
    }
    updates.deviceId =
      input.deviceId !== undefined ? input.deviceId : (readSkybridgeDeviceId(sqlite) ?? null);

    db.update(notes).set(updates).where(eq(notes.id, id)).run();

    if (input.tags !== undefined) {
      syncNoteTags(db, sqlite, id, input.tags);
      // P5-c G5: stamp reminder_status atomically. Covers /alarm being
      // added, /alarm fireAt changing, and /alarm being removed (passing
      // tags=[] clears reminder_status here). Daemon scheduler.onNoteChanged
      // still re-runs (idempotent) for the in-memory timer refresh.
      syncReminders(db, sqlite, id);
    }

    // Sparse post-state. content_hash + device_id derived server-side from
    // (content, sync_changes.device_id), so omit from payload.
    const payload: Record<string, unknown> = { updated_at_ms: nowMs };
    if (input.content !== undefined) payload.content = input.content;
    if (input.folderId !== undefined) payload.folder_id = input.folderId;
    if (input.tags !== undefined) {
      payload.tags = input.tags.map((t) => ({ tag_type: t.tagType, tag_value: t.tagValue }));
    }
    emitSyncChange(sqlite, {
      entityType: 'note',
      entityId: id,
      op: 'update',
      payload,
      nowMs,
    });

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
    const nowMs = now.getTime();
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

    emitSyncChange(sqlite, {
      entityType: 'note',
      entityId: id,
      op: 'trash',
      payload: {
        trash_level: newLevel,
        trashed_at_ms: nowMs,
        auto_delete_at_ms: autoDeleteAt ? autoDeleteAt.getTime() : null,
        updated_at_ms: nowMs,
      },
      nowMs,
    });

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

    const now = new Date();
    const nowMs = now.getTime();
    const newLevel = note.trashLevel - 1;
    const newTrashedAt = newLevel === 0 ? null : note.trashedAt;
    db.update(notes)
      .set({
        trashLevel: newLevel,
        trashedAt: newTrashedAt,
        autoDeleteAt: null,
        updatedAt: now,
      })
      .where(eq(notes.id, id))
      .run();

    emitSyncChange(sqlite, {
      entityType: 'note',
      entityId: id,
      op: 'restore',
      payload: {
        trash_level: newLevel,
        trashed_at_ms: newTrashedAt ? newTrashedAt.getTime() : null,
        auto_delete_at_ms: null,
        updated_at_ms: nowMs,
      },
      nowMs,
    });

    return getNote(db, id);
  });
  return run.immediate() as NoteWithTags | null;
}

/** Permanent delete */
export function permanentDeleteNote(
  db: OwlDatabase,
  sqlite: Database.Database,
  id: string,
): boolean {
  if (isSpecialNote(id)) return false;
  return sqlite
    .transaction(() => {
      const result = db.delete(notes).where(eq(notes.id, id)).run();
      if (result.changes === 0) return false;
      // P5-a Step 0b: include updated_at_ms so the apply-side LWW
      // (notes.updated_at vs payload.updated_at_ms) has a comparable
      // timestamp on the remote side. Pre-Step-0b emit was `{}`, which
      // would have been rejected by parseNotePayload at apply time.
      emitSyncChange(sqlite, {
        entityType: 'note',
        entityId: id,
        op: 'delete',
        payload: { updated_at_ms: Date.now() },
      });
      return true;
    })
    .immediate();
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
export function batchPermanentDeleteNotes(
  db: OwlDatabase,
  sqlite: Database.Database,
  ids: string[],
): number {
  if (ids.length === 0) return 0;
  let count = 0;

  for (const id of ids) {
    if (permanentDeleteNote(db, sqlite, id)) count++;
  }

  return count;
}

// `syncNoteTags` lives in ./tags.ts (P5-b §5.1) so the sync apply path can reuse it.

export { contentHash } from './hash.js';
export { syncNoteTags } from './tags.js';

// ─── P3.4-a: pin / reorder helpers ─────────────────────

/**
 * Toggle a note's pinned state. `pinned=true` stamps `pinned_at = Date.now()`;
 * `pinned=false` clears it to NULL. **Must not touch `updated_at`** — pin is
 * UI metadata, not content state. Callers who relied on `updateNote()` would
 * accidentally bump updated_at and reshuffle the list under the user.
 *
 * Returns the note's updated `pinnedAt` value (or null) so the API layer can
 * echo back without a second read.
 *
 * Throws if the note does not exist. Silently accepts special notes — their
 * pin state is user preference like any other.
 */
export function setNotePinned(
  db: OwlDatabase,
  sqlite: Database.Database,
  id: string,
  pinned: boolean,
): Date | null {
  return sqlite
    .transaction(() => {
      const existing = db.select().from(notes).where(eq(notes.id, id)).get();
      if (!existing) throw new Error(`Note ${id} not found`);

      const next = pinned ? new Date() : null;
      db.update(notes).set({ pinnedAt: next }).where(eq(notes.id, id)).run();

      emitSyncChange(sqlite, {
        entityType: 'note',
        entityId: id,
        op: 'pin',
        payload: { pinned_at_ms: next ? next.getTime() : null },
      });

      return next;
    })
    .immediate();
}

/**
 * Rewrite `position` for every note in a folder, in the order given.
 * `folderId=null` means the "unfiled" scope (folder_id IS NULL).
 *
 * Called by `POST /notes/reorder` after the frontend computes the target
 * order. Writes `position = 1000, 2000, 3000, ...` in a single transaction so
 * partial updates never surface. **Does not touch `updated_at`** — reorder is
 * sort metadata, not a content edit.
 *
 * Validation (throws if violated):
 *   - Every id exists and belongs to the specified folder
 *   - Every trash_level=0 note in the folder is present in orderedIds
 *     (no adds, no drops — the frontend must send the complete order)
 *   - No duplicates in orderedIds
 *
 * The caller is the API layer, which surfaces these as HTTP 400.
 */
export function reorderNotesInFolder(
  _db: OwlDatabase,
  sqlite: Database.Database,
  folderId: string | null,
  orderedIds: string[],
): void {
  // Validate: no duplicates
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (seen.has(id)) {
      throw new Error(`Duplicate id in orderedIds: ${id}`);
    }
    seen.add(id);
  }

  // Validate: the set of orderedIds must equal the set of trash_level=0 notes
  // in the target folder. Reading via raw sqlite keeps the IS NULL comparison
  // clean (drizzle's `eq(col, null)` compiles to `= NULL`, which is always
  // false in SQL).
  const currentIds = (
    folderId === null
      ? sqlite.prepare('SELECT id FROM notes WHERE folder_id IS NULL AND trash_level = 0').all()
      : sqlite.prepare('SELECT id FROM notes WHERE folder_id = ? AND trash_level = 0').all(folderId)
  ) as { id: string }[];

  if (currentIds.length !== orderedIds.length) {
    throw new Error(
      `orderedIds length ${orderedIds.length} does not match folder ${folderId ?? '<unfiled>'} note count ${currentIds.length}`,
    );
  }
  const currentSet = new Set(currentIds.map((r) => r.id));
  for (const id of orderedIds) {
    if (!currentSet.has(id)) {
      throw new Error(`Note ${id} is not in folder ${folderId ?? '<unfiled>'} (or is trashed)`);
    }
  }

  // Apply in a single transaction: position i*1000 (1-indexed) for each id.
  // Per-note `note/update` sync_changes emitted in the same tx so a partial
  // failure rolls back both positions and change-log rows.
  const tx = sqlite.transaction((ids: string[]) => {
    const stmt = sqlite.prepare('UPDATE notes SET position = ? WHERE id = ?');
    const nowMs = Date.now();
    for (let i = 0; i < ids.length; i++) {
      const position = (i + 1) * 1000;
      stmt.run(position, ids[i]);
      emitSyncChange(sqlite, {
        entityType: 'note',
        entityId: ids[i],
        op: 'update',
        payload: { position },
        nowMs,
      });
    }
  });
  tx.immediate(orderedIds);
}
