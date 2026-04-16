import { SPECIAL_NOTES, getNote, updateNote } from '@owl/core';
import type { ToolDef, WriteToolResult } from '../tool-registry.js';
import { requireString } from './args.js';

export const appendMemoTool: ToolDef = {
  name: 'append_memo',
  description:
    'Append a line of text to the user\'s special "memo" note (a free-form scratch pad). ' +
    'Tier-1 write: the change is committed to the database immediately. The GUI receives a ' +
    '`note_applied` event so it can refresh the open tab (or surface a conflict if the user ' +
    'is editing it). Use this for quick captures the user asks you to "jot down" or "remember".',
  parameters: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Plain text to append (no need to add a leading newline).',
      },
    },
    required: ['text'],
  },
  async execute(args, ctx): Promise<WriteToolResult> {
    const text = requireString(args, 'text');
    const memo = getNote(ctx.db, SPECIAL_NOTES.MEMO);
    if (!memo) {
      throw new Error('memo special note missing — ensureSpecialNotes was not called');
    }

    const newContent = appendBlock(memo.content, text);
    // Only update content; tags on memo are managed by the user via the
    // editor and should not be touched by an automated append.
    const updated = updateNote(ctx.db, ctx.sqlite, SPECIAL_NOTES.MEMO, {
      content: newContent,
      deviceId: ctx.deviceId,
    });
    if (!updated) {
      throw new Error('failed to update memo note');
    }

    return {
      message: `Appended ${text.length} chars to the memo.`,
      sideEffect: {
        type: 'note_applied',
        payload: {
          note_id: SPECIAL_NOTES.MEMO,
          content: updated.content,
          appended_text: text,
        },
      },
    };
  },
};

/**
 * Append `text` to `existing`, ensuring exactly one blank-line separator.
 * Empty notes get the text directly with no leading newlines.
 */
function appendBlock(existing: string, text: string): string {
  if (!existing.trim()) return text;
  const trimmed = existing.replace(/\s+$/, '');
  return `${trimmed}\n\n${text}`;
}
