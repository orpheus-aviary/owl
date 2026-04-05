import {
  batchDeleteNotes,
  batchRestoreNotes,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  parseTags,
  permanentDeleteNote,
  restoreNote,
  updateNote,
} from '@owl/core';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { created, fail, ok } from '../response.js';

export function registerNoteRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /notes — list notes
  app.get('/notes', async (req, reply) => {
    const query = req.query as {
      q?: string;
      folder_id?: string;
      trash_level?: string;
      tags?: string;
      page?: string;
      limit?: string;
    };

    const result = listNotes(ctx.db, ctx.sqlite, {
      q: query.q,
      folderId: query.folder_id === 'null' ? null : query.folder_id,
      trashLevel: query.trash_level ? Number(query.trash_level) : 0,
      tagValues: query.tags ? query.tags.split(',') : undefined,
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

    const note = createNote(ctx.db, ctx.sqlite, {
      content: body.content,
      folderId: body.folder_id ?? null,
      tags: body.tags ? parseTags(body.tags) : undefined,
      deviceId: ctx.deviceId,
    });

    created(reply, note, 'Note created');
  });

  // PUT /notes/:id — full update
  app.put('/notes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { content: string; tags?: string[] };

    const note = updateNote(ctx.db, ctx.sqlite, id, {
      content: body.content,
      tags: body.tags ? parseTags(body.tags) : undefined,
      deviceId: ctx.deviceId,
    });

    if (!note) return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');
    ok(reply, note, 'Note updated');
  });

  // PATCH /notes/:id — partial update
  app.patch('/notes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { content?: string; folder_id?: string | null; tags?: string[] };

    const updates: Parameters<typeof updateNote>[3] = { deviceId: ctx.deviceId };
    if (body.content !== undefined) updates.content = body.content;
    if (body.folder_id !== undefined) updates.folderId = body.folder_id;
    if (body.tags !== undefined) updates.tags = parseTags(body.tags);

    const note = updateNote(ctx.db, ctx.sqlite, id, updates);
    if (!note) return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');
    ok(reply, note, 'Note updated');
  });

  // DELETE /notes/:id — soft delete
  app.delete('/notes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deleteNote(ctx.db, id)) return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');
    ok(reply, null, 'Note moved to trash');
  });

  // POST /notes/:id/restore
  app.post('/notes/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!restoreNote(ctx.db, id))
      return fail(reply, 404, 'Note not found or not in trash', 'RESTORE_FAILED');
    ok(reply, null, 'Note restored');
  });

  // POST /notes/:id/permanent-delete
  app.post('/notes/:id/permanent-delete', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!permanentDeleteNote(ctx.db, id))
      return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');
    ok(reply, null, 'Note permanently deleted');
  });

  // POST /notes/batch-delete
  app.post('/notes/batch-delete', async (req, reply) => {
    const body = req.body as { ids: string[] };
    if (!body.ids?.length) return fail(reply, 400, 'IDs required', 'MISSING_IDS');
    const count = batchDeleteNotes(ctx.db, body.ids);
    ok(reply, { count }, `${count} notes moved to trash`);
  });

  // POST /notes/batch-restore
  app.post('/notes/batch-restore', async (req, reply) => {
    const body = req.body as { ids: string[] };
    if (!body.ids?.length) return fail(reply, 400, 'IDs required', 'MISSING_IDS');
    const count = batchRestoreNotes(ctx.db, body.ids);
    ok(reply, { count }, `${count} notes restored`);
  });
}
