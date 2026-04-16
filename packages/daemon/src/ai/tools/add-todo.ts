import { SPECIAL_NOTES, getNote, updateNote } from '@owl/core';
import type { ToolDef, WriteToolResult } from '../tool-registry.js';
import { requireString } from './args.js';

export const addTodoTool: ToolDef = {
  name: 'add_todo',
  description:
    'Append an unchecked todo line (`- [ ] <content>`) to the user\'s special "todo" note. ' +
    'Tier-1 write: committed immediately, GUI gets a `note_applied` event. Use when the user ' +
    'asks you to "add a task" / "remind me to" without specifying a target note.',
  parameters: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The task description (no leading dash or checkbox needed).',
      },
    },
    required: ['content'],
  },
  async execute(args, ctx): Promise<WriteToolResult> {
    const content = requireString(args, 'content');
    const todo = getNote(ctx.db, SPECIAL_NOTES.TODO);
    if (!todo) {
      throw new Error('todo special note missing — ensureSpecialNotes was not called');
    }

    const todoLine = `- [ ] ${content}`;
    const newContent = appendTodoLine(todo.content, todoLine);
    const updated = updateNote(ctx.db, ctx.sqlite, SPECIAL_NOTES.TODO, {
      content: newContent,
      deviceId: ctx.deviceId,
    });
    if (!updated) {
      throw new Error('failed to update todo note');
    }

    return {
      message: `Added todo: ${content}`,
      sideEffect: {
        type: 'note_applied',
        payload: {
          note_id: SPECIAL_NOTES.TODO,
          content: updated.content,
          appended_text: todoLine,
        },
      },
    };
  },
};

/**
 * Append a single todo line. The default todo template (see special-notes.ts)
 * ends with `- [ ] ` (an empty unchecked item). If we land on that, replace
 * the dangling line in place; otherwise append on a new line.
 */
function appendTodoLine(existing: string, todoLine: string): string {
  const trimmed = existing.replace(/\s+$/, '');
  if (/- \[ \]\s*$/.test(trimmed)) {
    return trimmed.replace(/- \[ \]\s*$/, todoLine);
  }
  if (!trimmed) return todoLine;
  return `${trimmed}\n${todoLine}`;
}
