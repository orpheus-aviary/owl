import { listNotes } from '@owl/core';
import type { ToolDef } from '../tool-registry.js';
import { getBoolean, getNullableString } from './args.js';

// NOTE: Keep this regex in sync with the copies in
// packages/daemon/src/routes/todos.ts and
// packages/gui/src/renderer/src/lib/todo-parser.ts. All three parse the same
// markdown todo syntax (`- [ ]` / `- [x]`); divergence breaks the dirty-tab
// overlay on the todo page.
const TODO_LINE_RE = /^(\s*)- \[([ xX])\]\s+(.*)$/;

export const getTodosTool: ToolDef = {
  name: 'get_todos',
  description:
    'Extract markdown todo items (`- [ ]` / `- [x]`) from all non-trashed notes, grouped by note. ' +
    'Use this to answer "what do I have to do" questions or to find a specific task before ' +
    'editing the underlying note.',
  parameters: {
    type: 'object',
    properties: {
      checked: {
        type: 'boolean',
        description: 'When set, return only checked (true) or only unchecked (false) items.',
      },
      folder_id: {
        type: ['string', 'null'],
        description: 'Restrict to notes in this folder (null = root/unfiled).',
      },
    },
  },
  async execute(args, ctx) {
    const checkedFilter = getBoolean(args, 'checked');
    const folderId = getNullableString(args, 'folder_id');

    const result = listNotes(ctx.db, ctx.sqlite, {
      trashLevel: 0,
      folderId,
      includeDescendants: true,
      limit: 10000,
    });

    const groups = result.items
      .map((note) => buildTodoGroup(note, checkedFilter))
      .filter((g): g is TodoGroup => g !== null)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    return { groups, total_groups: groups.length };
  },
};

interface TodoItem {
  line: number;
  text: string;
  checked: boolean;
}

interface TodoGroup {
  note_id: string;
  note_title: string;
  updated_at: string;
  items: TodoItem[];
}

function buildTodoGroup(
  note: { id: string; content: string; updatedAt: Date },
  checkedFilter: boolean | undefined,
): TodoGroup | null {
  const items: TodoItem[] = [];
  const lines = note.content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TODO_LINE_RE);
    if (m) {
      items.push({ line: i + 1, text: m[3], checked: m[2].toLowerCase() === 'x' });
    }
  }
  if (items.length === 0) return null;

  const visible =
    checkedFilter === undefined ? items : items.filter((it) => it.checked === checkedFilter);
  if (visible.length === 0) return null;

  return {
    note_id: note.id,
    note_title: extractTitle(note.content),
    updated_at: note.updatedAt.toISOString(),
    items: visible,
  };
}

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  if (match) return match[1].trim();
  const firstLine = content.split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 30) || '无标题';
}
