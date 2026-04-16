import { getNote } from '@owl/core';
import type { ToolDef } from '../tool-registry.js';
import { requireString } from './args.js';

export const getNoteTool: ToolDef = {
  name: 'get_note',
  description:
    'Fetch a single note by id with its full content and tags. Use after `search_notes` ' +
    'when you need the entire body of a note that came back truncated.',
  parameters: {
    type: 'object',
    properties: {
      note_id: { type: 'string', description: 'The note id (uuid).' },
    },
    required: ['note_id'],
  },
  async execute(args, ctx) {
    const id = requireString(args, 'note_id');
    const note = getNote(ctx.db, id);
    if (!note) return { error: `Note not found: ${id}` };
    return {
      id: note.id,
      content: note.content,
      folder_id: note.folderId,
      created_at: note.createdAt.toISOString(),
      updated_at: note.updatedAt.toISOString(),
      tags: note.tags.map((t) => ({ type: t.tagType, value: t.tagValue ?? '' })),
    };
  },
};
