import type { OwlDatabase } from '@owl/core';
import { createNote, parseTags, updateNote } from '@owl/core';
import type Database from 'better-sqlite3';
import type { ReminderScheduler } from '../../scheduler.js';
import type { StoredPreview } from '../preview-store.js';
import type { ToolDef } from '../tool-registry.js';
import { requireString } from './args.js';

export const applyUpdateTool: ToolDef = {
  name: 'apply_update',
  description:
    'Commit a previously-staged preview (created by `create_note`, `update_note`, or ' +
    '`create_reminder` when called with source=external) to the database. Returns the resulting ' +
    'note id, or an error if the preview has expired or already been applied.',
  parameters: {
    type: 'object',
    properties: {
      preview_id: {
        type: 'string',
        description: 'Preview id returned in the prior `preview_ready` event.',
      },
    },
    required: ['preview_id'],
  },
  async execute(args, ctx) {
    const previewId = requireString(args, 'preview_id');
    const stored = ctx.previewStore.consume(previewId);
    if (!stored) {
      return { error: `preview not found or expired: ${previewId}` };
    }
    const result = applyPreview(stored, ctx.db, ctx.sqlite, ctx.deviceId, ctx.scheduler);
    return result;
  },
};

/**
 * Shared write path used by both the `apply_update` tool and the
 * `POST /ai/preview/apply` HTTP route. Returns the note id and a status
 * message; throws on an unrecoverable DB error so the caller can surface a
 * 500 / tool error.
 */
export function applyPreview(
  stored: StoredPreview,
  db: OwlDatabase,
  sqlite: Database.Database,
  deviceId: string,
  scheduler: ReminderScheduler,
): { note_id: string; action: string; message: string } | { error: string } {
  const { payload } = stored;
  const tags = parseTags(payload.tags);

  if (payload.action === 'create' || payload.action === 'create_reminder') {
    const note = createNote(db, sqlite, {
      content: payload.content,
      folderId: payload.folder_id ?? null,
      tags,
      deviceId,
    });
    scheduler.onNoteChanged(note.id);
    return {
      note_id: note.id,
      action: payload.action,
      message: `Created note ${note.id}.`,
    };
  }

  // action === 'update'
  if (!payload.note_id) {
    return { error: 'update preview missing note_id' };
  }
  const updated = updateNote(db, sqlite, payload.note_id, {
    content: payload.content,
    tags,
    folderId: payload.folder_id,
    deviceId,
  });
  if (!updated) {
    return { error: `note no longer exists: ${payload.note_id}` };
  }
  scheduler.onNoteChanged(updated.id);
  return {
    note_id: updated.id,
    action: 'update',
    message: `Updated note ${updated.id}.`,
  };
}
