import {
  AlreadyTrashedError,
  SPECIAL_NOTES,
  VersionMismatchError,
  batchDeleteNotes,
  batchPermanentDeleteNotes,
  batchRestoreNotes,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  parseTags,
  permanentDeleteNote,
  reorderNotesInFolder,
  restoreNote,
  setNotePinned,
  updateNote,
} from '@owl/core';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { created, fail, ok } from '../response.js';

const SPECIAL_NOTE_IDS: ReadonlySet<string> = new Set(Object.values(SPECIAL_NOTES));
const SPECIAL_PROTECTED_MSG = '系统笔记不可删除';

export function registerNoteRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /notes — list notes
  app.get('/notes', async (req, reply) => {
    const query = req.query as {
      q?: string;
      folder_id?: string;
      include_descendants?: string;
      trash_level?: string;
      tags?: string;
      sort_by?: string;
      sort_order?: string;
      pinned_first?: string;
      page?: string;
      limit?: string;
    };

    // sort_by accepts 'updated' | 'created' | 'position'; anything else falls
    // back to 'updated' (same tolerance as before, but now includes 'position'
    // for P3.4-a FolderPanel consumers).
    const sortBy: 'updated' | 'created' | 'position' =
      query.sort_by === 'created' || query.sort_by === 'position' ? query.sort_by : 'updated';

    const result = listNotes(ctx.db, ctx.sqlite, {
      q: query.q,
      folderId: query.folder_id === 'null' ? null : query.folder_id,
      includeDescendants: query.include_descendants !== 'false',
      trashLevel: query.trash_level ? Number(query.trash_level) : 0,
      tagValues: query.tags ? query.tags.split(',') : undefined,
      sortBy,
      sortOrder: query.sort_order === 'asc' ? 'asc' : 'desc',
      pinnedFirst: query.pinned_first === 'true',
      page: query.page ? Number(query.page) : 1,
      limit: query.limit ? Number(query.limit) : 20,
    });

    ok(reply, result.items, undefined, result.total);
  });

  // GET /notes/:id — get single note
  app.get('/notes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const note = getNote(ctx.db, id);
    if (!note) return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');
    ok(reply, note);
  });

  // POST /notes — create note
  app.post('/notes', async (req, reply) => {
    const body = req.body as { content: string; folder_id?: string; tags?: string[] };
    if (!body.content) return fail(reply, 400, 'Content is required', 'MISSING_CONTENT');

    const rawTags = body.tags ?? [];
    const note = createNote(ctx.db, ctx.sqlite, {
      content: body.content,
      folderId: body.folder_id ?? null,
      tags: parseTags(rawTags),
      deviceId: ctx.deviceId,
    });

    ctx.scheduler.onNoteChanged(note.id);
    created(reply, note, 'Note created');
  });

  // PUT /notes/:id — strict full replace. Body must include content, tags,
  // and folder_id; missing any → USAGE_ERROR. Supports expected_updated_at
  // for optimistic concurrency (409 VERSION_MISMATCH on mismatch).
  app.put('/notes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      content?: string;
      tags?: string[];
      folder_id?: string | null;
      expected_updated_at?: number;
    };

    if (body.content === undefined) {
      return fail(reply, 400, 'content is required for PUT', 'USAGE_ERROR');
    }
    if (body.tags === undefined) {
      return fail(reply, 400, 'tags is required for PUT', 'USAGE_ERROR');
    }
    if (body.folder_id === undefined) {
      return fail(reply, 400, 'folder_id is required for PUT', 'USAGE_ERROR');
    }

    try {
      const note = updateNote(
        ctx.db,
        ctx.sqlite,
        id,
        {
          content: body.content,
          tags: parseTags(body.tags),
          folderId: body.folder_id,
          deviceId: ctx.deviceId,
        },
        body.expected_updated_at !== undefined
          ? { expectedUpdatedAt: body.expected_updated_at }
          : undefined,
      );
      if (!note) return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');
      ctx.scheduler.onNoteChanged(note.id);
      ok(reply, note, 'Note updated');
    } catch (err) {
      if (err instanceof VersionMismatchError) {
        return fail(reply, 409, err.message, 'VERSION_MISMATCH', {
          expected: err.expected,
          current: err.current,
        });
      }
      throw err;
    }
  });

  // PATCH /notes/:id — partial update. Supports expected_updated_at.
  app.patch('/notes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      content?: string;
      folder_id?: string | null;
      tags?: string[];
      expected_updated_at?: number;
    };

    const updates: Parameters<typeof updateNote>[3] = { deviceId: ctx.deviceId };
    if (body.content !== undefined) updates.content = body.content;
    if (body.folder_id !== undefined) updates.folderId = body.folder_id;
    if (body.tags !== undefined) updates.tags = parseTags(body.tags);

    try {
      const note = updateNote(
        ctx.db,
        ctx.sqlite,
        id,
        updates,
        body.expected_updated_at !== undefined
          ? { expectedUpdatedAt: body.expected_updated_at }
          : undefined,
      );
      if (!note) return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');
      ctx.scheduler.onNoteChanged(note.id);
      ok(reply, note, 'Note updated');
    } catch (err) {
      if (err instanceof VersionMismatchError) {
        return fail(reply, 409, err.message, 'VERSION_MISMATCH', {
          expected: err.expected,
          current: err.current,
        });
      }
      throw err;
    }
  });

  // DELETE /notes/:id — soft delete. Supports expected_updated_at and
  // reject_if_trashed (CLI opt-in). Returns the updated note.
  app.delete('/notes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (SPECIAL_NOTE_IDS.has(id))
      return fail(reply, 403, SPECIAL_PROTECTED_MSG, 'SPECIAL_NOTE_PROTECTED');

    const body = (req.body ?? {}) as {
      expected_updated_at?: number;
      reject_if_trashed?: boolean;
    };

    try {
      const note = deleteNote(ctx.db, ctx.sqlite, id, {
        autoDeleteDays: ctx.config.trash.auto_delete_days,
        expectedUpdatedAt: body.expected_updated_at,
        rejectIfTrashed: body.reject_if_trashed,
      });
      if (!note) return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');
      ctx.scheduler.onNoteChanged(id);
      ok(reply, note, 'Note moved to trash');
    } catch (err) {
      if (err instanceof VersionMismatchError) {
        return fail(reply, 409, err.message, 'VERSION_MISMATCH', {
          expected: err.expected,
          current: err.current,
        });
      }
      if (err instanceof AlreadyTrashedError) {
        return fail(reply, 409, err.message, 'ALREADY_TRASHED', {
          current_trash_level: err.currentTrashLevel,
        });
      }
      throw err;
    }
  });

  // POST /notes/:id/restore — supports expected_updated_at. Returns the
  // updated note.
  app.post('/notes/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { expected_updated_at?: number };
    try {
      const note = restoreNote(
        ctx.db,
        ctx.sqlite,
        id,
        body.expected_updated_at !== undefined
          ? { expectedUpdatedAt: body.expected_updated_at }
          : undefined,
      );
      if (!note) return fail(reply, 404, 'Note not found or not in trash', 'RESTORE_FAILED');
      ctx.scheduler.onNoteChanged(id);
      ok(reply, note, 'Note restored');
    } catch (err) {
      if (err instanceof VersionMismatchError) {
        return fail(reply, 409, err.message, 'VERSION_MISMATCH', {
          expected: err.expected,
          current: err.current,
        });
      }
      throw err;
    }
  });

  // POST /notes/:id/permanent-delete
  app.post('/notes/:id/permanent-delete', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (SPECIAL_NOTE_IDS.has(id))
      return fail(reply, 403, SPECIAL_PROTECTED_MSG, 'SPECIAL_NOTE_PROTECTED');
    if (!permanentDeleteNote(ctx.db, id))
      return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');
    ok(reply, null, 'Note permanently deleted');
  });

  // POST /notes/batch-delete
  app.post('/notes/batch-delete', async (req, reply) => {
    const body = req.body as { ids: string[] };
    if (!body.ids?.length) return fail(reply, 400, 'IDs required', 'MISSING_IDS');
    const count = batchDeleteNotes(ctx.db, ctx.sqlite, body.ids, ctx.config.trash.auto_delete_days);
    if (count > 0) ctx.scheduler.scheduleNextTrashCleanup();
    ok(reply, { count }, `${count} notes moved to trash`);
  });

  // POST /notes/batch-restore
  app.post('/notes/batch-restore', async (req, reply) => {
    const body = req.body as { ids: string[] };
    if (!body.ids?.length) return fail(reply, 400, 'IDs required', 'MISSING_IDS');
    const count = batchRestoreNotes(ctx.db, ctx.sqlite, body.ids);
    if (count > 0) ctx.scheduler.scheduleNextTrashCleanup();
    ok(reply, { count }, `${count} notes restored`);
  });

  // POST /notes/batch-permanent-delete
  app.post('/notes/batch-permanent-delete', async (req, reply) => {
    const body = req.body as { ids: string[] };
    if (!body.ids?.length) return fail(reply, 400, 'IDs required', 'MISSING_IDS');
    const count = batchPermanentDeleteNotes(ctx.db, body.ids);
    ok(reply, { count }, `${count} notes permanently deleted`);
  });

  // PATCH /notes/:id/pin — toggle pinned_at (P3.4-a).
  // Returns the full note so the client can replace its local copy without
  // refetching. Does NOT bump updated_at (pin is UI metadata).
  app.patch('/notes/:id/pin', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { pinned?: boolean };
    if (typeof body.pinned !== 'boolean') {
      return fail(reply, 400, 'pinned (boolean) is required', 'USAGE_ERROR');
    }
    try {
      setNotePinned(ctx.db, id, body.pinned);
    } catch (err) {
      if (err instanceof Error && /not found/.test(err.message)) {
        return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');
      }
      throw err;
    }
    const note = getNote(ctx.db, id);
    if (!note) return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');
    ok(reply, note, body.pinned ? 'Note pinned' : 'Note unpinned');
  });

  // POST /notes/reorder — rewrite position for every note in a folder (P3.4-a).
  // body.folder_id may be null to address the "unfiled" scope.
  // body.ordered_ids must be the complete set of trash_level=0 notes in that
  // scope, no duplicates, no outsiders — core validation throws, we map to 400.
  app.post('/notes/reorder', async (req, reply) => {
    const body = req.body as { folder_id?: string | null; ordered_ids?: string[] };
    if (body.folder_id === undefined) {
      return fail(reply, 400, 'folder_id is required (use null for unfiled)', 'USAGE_ERROR');
    }
    if (!Array.isArray(body.ordered_ids)) {
      return fail(reply, 400, 'ordered_ids must be an array', 'USAGE_ERROR');
    }
    try {
      reorderNotesInFolder(ctx.db, ctx.sqlite, body.folder_id, body.ordered_ids);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(reply, 400, message, 'REORDER_INVALID');
    }
    ok(reply, { count: body.ordered_ids.length }, 'Notes reordered');
  });
}
