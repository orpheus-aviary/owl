import { getNote, listNotes, updateNote } from '@owl/core';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';

// ─── Todo Parser ───────────────────────────────────────
//
// NOTE: This regex must stay in sync with the renderer copy at
// packages/gui/src/renderer/src/lib/todo-parser.ts — both sides parse the
// same markdown todo syntax and any divergence will cause the todo page's
// dirty-tab overlay to produce inconsistent results.

const TODO_LINE_RE = /^(\s*)- \[([ xX])\]\s+(.*)$/;

export interface TodoItem {
  line: number; // 1-based line number
  text: string;
  checked: boolean;
}

export interface TodoGroup {
  note_id: string;
  note_title: string;
  updated_at: string;
  items: TodoItem[];
}

/** Extract the first non-empty line as title (strips leading # markers). */
function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  if (match) return match[1].trim();
  const firstLine = content.split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 30) || '无标题';
}

/** Parse all markdown todo items (`- [ ]` / `- [x]`) from a note's content. */
export function parseTodosFromContent(content: string): TodoItem[] {
  const items: TodoItem[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(TODO_LINE_RE);
    if (match) {
      items.push({
        line: i + 1,
        text: match[3],
        checked: match[2].toLowerCase() === 'x',
      });
    }
  }
  return items;
}

interface TodoQueryOpts {
  filterChecked: boolean | undefined;
  folderId: string | null | undefined;
  includeDescendants: boolean;
}

function parseTodoQuery(query: {
  checked?: string;
  folder_id?: string;
  include_descendants?: string;
}): TodoQueryOpts {
  return {
    filterChecked: query.checked === undefined ? undefined : query.checked === 'true',
    folderId: query.folder_id === 'null' ? null : query.folder_id,
    includeDescendants: query.include_descendants !== 'false',
  };
}

function buildTodoGroup(
  note: { id: string; content: string; updatedAt: Date },
  filterChecked: boolean | undefined,
): TodoGroup | null {
  const items = parseTodosFromContent(note.content);
  if (items.length === 0) return null;

  const visible =
    filterChecked === undefined ? items : items.filter((it) => it.checked === filterChecked);
  if (visible.length === 0) return null;

  return {
    note_id: note.id,
    note_title: extractTitle(note.content),
    updated_at: note.updatedAt.toISOString(),
    items: visible,
  };
}

// ─── Routes ────────────────────────────────────────────

export function registerTodoRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /todos — list all todos across non-trashed notes, grouped by note
  app.get('/todos', async (req, reply) => {
    const { filterChecked, folderId, includeDescendants } = parseTodoQuery(
      req.query as { checked?: string; folder_id?: string; include_descendants?: string },
    );

    const result = listNotes(ctx.db, ctx.sqlite, {
      trashLevel: 0,
      folderId,
      includeDescendants,
      limit: 10000, // todo extraction runs on all notes; cap generously
    });

    const groups: TodoGroup[] = [];
    for (const note of result.items) {
      const group = buildTodoGroup(note, filterChecked);
      if (group) groups.push(group);
    }

    // Sort by note updated_at desc so the most recently edited notes surface first.
    groups.sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    ok(reply, groups, undefined, groups.length);
  });

  // PATCH /notes/:id/toggle-todo — flip a single todo line in a note's content.
  // This endpoint is ONLY used by the todo page when the target note is NOT
  // currently open in an editor tab. When a tab is open, the renderer writes
  // to the editor store directly to avoid overwriting unsaved local edits.
  app.patch('/notes/:id/toggle-todo', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { line?: number };

    if (!body.line || body.line < 1) {
      return fail(reply, 400, 'line is required and must be >= 1', 'INVALID_LINE');
    }

    const note = getNote(ctx.db, id);
    if (!note) return fail(reply, 404, 'Note not found', 'NOTE_NOT_FOUND');

    const lines = note.content.split('\n');
    if (body.line > lines.length) {
      return fail(reply, 400, 'line out of range', 'INVALID_LINE');
    }

    const targetLine = lines[body.line - 1];
    const match = targetLine.match(TODO_LINE_RE);
    if (!match) {
      return fail(reply, 400, 'line is not a todo item', 'NOT_A_TODO');
    }

    const [, indent, mark, text] = match;
    const newMark = mark.toLowerCase() === 'x' ? ' ' : 'x';
    lines[body.line - 1] = `${indent}- [${newMark}] ${text}`;
    const newContent = lines.join('\n');

    const updated = updateNote(ctx.db, ctx.sqlite, id, {
      content: newContent,
      deviceId: ctx.deviceId,
    });
    if (!updated) return fail(reply, 500, 'Failed to update note', 'UPDATE_FAILED');

    ctx.scheduler.onNoteChanged(id);
    ok(reply, updated, 'Todo toggled');
  });
}
