import {
  createFolder,
  deleteFolder,
  getFolder,
  listFolders,
  reorderFolders,
  updateFolder,
  updateNote,
} from '@owl/core';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { created, fail, ok } from '../response.js';

// ─── DTO helpers ───────────────────────────────────────
//
// Folder rows carry Date objects (drizzle `timestamp_ms` mode); serialize
// them consistently as ISO strings so the renderer doesn't have to branch.

function serializeFolder(f: {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  deviceId: string | null;
}) {
  return {
    id: f.id,
    name: f.name,
    parent_id: f.parentId,
    position: f.position,
    created_at: f.createdAt.toISOString(),
    updated_at: f.updatedAt.toISOString(),
    device_id: f.deviceId,
  };
}

export function registerFolderRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /folders — flat list, renderer assembles the tree
  app.get('/folders', async (_req, reply) => {
    const rows = listFolders(ctx.db);
    ok(reply, rows.map(serializeFolder), undefined, rows.length);
  });

  // POST /folders — create
  app.post('/folders', async (req, reply) => {
    const body = req.body as { name?: string; parent_id?: string | null; position?: number };
    if (!body.name || !body.name.trim()) {
      return fail(reply, 400, 'Folder name is required', 'MISSING_NAME');
    }

    // Validate parent exists when provided (FK would accept NULL silently otherwise).
    if (body.parent_id && !getFolder(ctx.db, body.parent_id)) {
      return fail(reply, 400, 'Parent folder not found', 'PARENT_NOT_FOUND');
    }

    const folder = createFolder(ctx.db, {
      name: body.name.trim(),
      parentId: body.parent_id ?? null,
      position: body.position,
      deviceId: ctx.deviceId,
    });
    created(reply, serializeFolder(folder), 'Folder created');
  });

  // PUT /folders/:id — rename / move
  app.put('/folders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { name?: string; parent_id?: string | null; position?: number };

    if (body.parent_id && !getFolder(ctx.db, body.parent_id)) {
      return fail(reply, 400, 'Parent folder not found', 'PARENT_NOT_FOUND');
    }

    try {
      const updated = updateFolder(ctx.db, id, {
        name: body.name,
        parentId: body.parent_id,
        position: body.position,
        deviceId: ctx.deviceId,
      });
      if (!updated) return fail(reply, 404, 'Folder not found', 'FOLDER_NOT_FOUND');
      ok(reply, serializeFolder(updated), 'Folder updated');
    } catch (err) {
      return fail(reply, 400, (err as Error).message, 'INVALID_PARENT');
    }
  });

  // DELETE /folders/:id — delete + promote children one level up
  app.delete('/folders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deleteFolder(ctx.db, id)) {
      return fail(reply, 404, 'Folder not found', 'FOLDER_NOT_FOUND');
    }
    ok(reply, null, 'Folder deleted');
  });

  // PATCH /folders/reorder — batch position / parent update
  app.patch('/folders/reorder', async (req, reply) => {
    const body = req.body as {
      items?: { id: string; parent_id: string | null; position: number }[];
    };
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return fail(reply, 400, 'items[] is required', 'MISSING_ITEMS');
    }
    const count = reorderFolders(
      ctx.db,
      ctx.sqlite,
      body.items.map((it) => ({
        id: it.id,
        parentId: it.parent_id,
        position: it.position,
      })),
    );
    ok(reply, { count }, `${count} folders reordered`);
  });

  // PATCH /notes/:id/move — move a single note to a (possibly null) folder.
  // Separate endpoint so the renderer doesn't have to send a full PATCH /notes
  // body just to change folder_id (and we avoid touching updated_at tag sync).
  app.patch('/notes/:id/move', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { folder_id?: string | null };

    if (body.folder_id === undefined) {
      return fail(reply, 400, 'folder_id is required (use null to unfile)', 'MISSING_FOLDER_ID');
    }
    if (body.folder_id !== null && !getFolder(ctx.db, body.folder_id)) {
      return fail(reply, 400, 'Folder not found', 'FOLDER_NOT_FOUND');
    }

    const note = updateNote(ctx.db, ctx.sqlite, id, {
      folderId: body.folder_id,
      deviceId: ctx.deviceId,
    });
    if (!note) return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');
    ok(reply, note, 'Note moved');
  });
}
