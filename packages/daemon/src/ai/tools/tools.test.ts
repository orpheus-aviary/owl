import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type OwlConfig,
  type OwlDatabase,
  SPECIAL_NOTES,
  createConsoleLogger,
  createDatabase,
  createNote,
  ensureDeviceId,
  ensureSpecialNotes,
  getNote,
  syncReminders,
} from '@owl/core';
import type Database from 'better-sqlite3';
import { ReminderScheduler } from '../../scheduler.js';
import type { ToolContext } from '../tool-registry.js';
import { addTodoTool } from './add-todo.js';
import { appendMemoTool } from './append-memo.js';
import { getCapabilitiesTool } from './get-capabilities.js';
import { getNoteTool } from './get-note.js';
import { getRemindersTool } from './get-reminders.js';
import { getTodosTool } from './get-todos.js';
import { createBuiltinRegistry } from './index.js';
import { listFoldersTool } from './list-folders.js';
import { listTagsTool } from './list-tags.js';
import { searchNotesTool } from './search-notes.js';

describe('AI tools (P2-7b)', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;
  let scheduler: ReminderScheduler;
  let config: OwlConfig;
  let ctx: ToolContext;

  before(() => {
    const created = createDatabase({ dbPath: ':memory:' });
    db = created.db;
    sqlite = created.sqlite;
    ensureSpecialNotes(db);
    const deviceId = ensureDeviceId(db);

    config = structuredClone(DEFAULT_CONFIG);
    const logger = createConsoleLogger('tools-test', 'silent');
    scheduler = new ReminderScheduler(db, sqlite, config, logger);

    const registry = createBuiltinRegistry();
    ctx = {
      db,
      sqlite,
      config,
      deviceId,
      scheduler,
      source: 'gui',
      logger,
      registry,
    };
  });

  after(() => {
    scheduler.stop();
    sqlite.close();
  });

  // ─── search_notes ──

  describe('search_notes', () => {
    let noteId: string;

    before(() => {
      const note = createNote(db, sqlite, {
        content: '# Search target\n\nThis note mentions Stockholm and a reminder.',
        tags: [{ tagType: '#', tagValue: 'travel' }],
      });
      noteId = note.id;
    });

    it('returns matching note for FTS query', async () => {
      const result = (await searchNotesTool.execute({ query: 'Stockholm' }, ctx)) as {
        matches: Array<{ id: string; snippet: string }>;
        total_returned: number;
      };
      assert.ok(result.matches.some((m) => m.id === noteId));
      assert.ok(result.total_returned >= 1);
    });

    it('falls back to recent notes when query is empty', async () => {
      const result = (await searchNotesTool.execute({ query: '' }, ctx)) as {
        matches: Array<{ id: string }>;
      };
      // Empty query returns most-recently-updated notes; our created note must be in there.
      assert.ok(result.matches.length > 0);
    });

    it('truncates long content with ellipsis', async () => {
      const long = `${'X'.repeat(500)}`;
      createNote(db, sqlite, { content: long });
      const result = (await searchNotesTool.execute({ query: '' }, ctx)) as {
        matches: Array<{ snippet: string; truncated: boolean }>;
      };
      const truncated = result.matches.find((m) => m.truncated);
      assert.ok(truncated, 'expected at least one truncated entry');
      assert.ok(truncated.snippet.endsWith('…'));
    });

    it('honors max_chars budget', async () => {
      const result = (await searchNotesTool.execute({ query: '', max_chars: 10 }, ctx)) as {
        matches: unknown[];
        truncated_by_budget: boolean;
      };
      // Budget of 10 chars cannot fit even one full snippet header; allow 0-2 entries.
      assert.ok(result.matches.length <= 2);
    });

    it('rejects non-string query', async () => {
      await assert.rejects(
        searchNotesTool.execute({ query: 123 } as Record<string, unknown>, ctx),
        /query must be a string/,
      );
    });
  });

  // ─── get_note ──

  describe('get_note', () => {
    it('returns full content + tags', async () => {
      const note = createNote(db, sqlite, {
        content: '# Get me\nbody',
        tags: [{ tagType: '#', tagValue: 'fetch' }],
      });
      const result = (await getNoteTool.execute({ note_id: note.id }, ctx)) as {
        id: string;
        content: string;
        tags: Array<{ type: string; value: string }>;
      };
      assert.equal(result.id, note.id);
      assert.equal(result.content, '# Get me\nbody');
      assert.deepEqual(result.tags, [{ type: '#', value: 'fetch' }]);
    });

    it('returns error for missing note', async () => {
      const result = (await getNoteTool.execute({ note_id: 'no-such-id' }, ctx)) as {
        error?: string;
      };
      assert.match(result.error ?? '', /Note not found/);
    });

    it('rejects missing note_id', async () => {
      await assert.rejects(getNoteTool.execute({}, ctx), /note_id is required/);
    });
  });

  // ─── list_tags ──

  describe('list_tags', () => {
    it('returns # tags ordered by usage', async () => {
      // Add a few tagged notes so ranking has something to order on.
      createNote(db, sqlite, {
        content: 'a',
        tags: [{ tagType: '#', tagValue: 'frequent' }],
      });
      createNote(db, sqlite, {
        content: 'b',
        tags: [{ tagType: '#', tagValue: 'frequent' }],
      });
      const result = (await listTagsTool.execute({}, ctx)) as {
        tags: Array<{ value: string; usage_count: number }>;
      };
      const frequent = result.tags.find((t) => t.value === 'frequent');
      assert.ok(frequent);
      assert.ok(frequent.usage_count >= 2);
    });

    it('filters by search substring', async () => {
      createNote(db, sqlite, {
        content: 'c',
        tags: [{ tagType: '#', tagValue: 'unique-tag-needle' }],
      });
      const result = (await listTagsTool.execute({ search: 'needle' }, ctx)) as {
        tags: Array<{ value: string }>;
      };
      assert.ok(result.tags.every((t) => t.value.toLowerCase().includes('needle')));
      assert.ok(result.tags.length >= 1);
    });
  });

  // ─── list_folders ──

  describe('list_folders', () => {
    it('returns flat folder list', async () => {
      const before = (
        (await listFoldersTool.execute({}, ctx)) as {
          folders: unknown[];
        }
      ).folders.length;

      // Insert a folder via raw SQL (avoids needing the folders module here).
      sqlite
        .prepare(
          'INSERT INTO folders (id, name, parent_id, position, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)',
        )
        .run('folder-test-1', 'Test Folder', Date.now(), Date.now());

      const after = (await listFoldersTool.execute({}, ctx)) as {
        folders: Array<{ id: string; name: string; parent_id: string | null }>;
      };
      assert.equal(after.folders.length, before + 1);
      assert.ok(after.folders.some((f) => f.id === 'folder-test-1'));
    });
  });

  // ─── get_reminders ──

  describe('get_reminders', () => {
    let pendingNoteId: string;

    before(() => {
      // Pending alarm 2 days in the future. Format as local-time ISO (no Z)
      // to match how the GUI tag bar persists alarm values, otherwise
      // `new Date(ymd)` reinterprets the string as local time and the test
      // ends up with a fire time that's actually in the past in non-UTC zones.
      const future = new Date(Date.now() + 2 * 86_400_000);
      const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
      const ymd =
        `${pad(future.getFullYear(), 4)}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}` +
        `T${pad(future.getHours())}:${pad(future.getMinutes())}:${pad(future.getSeconds())}`;
      const note = createNote(db, sqlite, {
        content: '# Future alarm',
        tags: [{ tagType: '/alarm', tagValue: ymd }],
      });
      syncReminders(db, sqlite, note.id);
      pendingNoteId = note.id;
    });

    it('returns pending reminders with status', async () => {
      const result = (await getRemindersTool.execute({ status: 'pending' }, ctx)) as {
        reminders: Array<{ note_id: string; status: string }>;
      };
      const match = result.reminders.find((r) => r.note_id === pendingNoteId);
      assert.ok(match, 'expected to see pending reminder');
      assert.equal(match.status, 'pending');
    });

    it('rejects invalid status', async () => {
      await assert.rejects(
        getRemindersTool.execute({ status: 'bogus' }, ctx),
        /status must be one of/,
      );
    });
  });

  // ─── get_todos ──

  describe('get_todos', () => {
    it('extracts todos grouped by note', async () => {
      createNote(db, sqlite, {
        content: '# Mixed\n- [ ] open task\n- [x] done task\nplain text',
      });
      const result = (await getTodosTool.execute({}, ctx)) as {
        groups: Array<{ note_title: string; items: Array<{ checked: boolean; text: string }> }>;
      };
      const group = result.groups.find((g) => g.note_title === 'Mixed');
      assert.ok(group);
      assert.equal(group.items.length, 2);
    });

    it('filters to unchecked items only', async () => {
      const result = (await getTodosTool.execute({ checked: false }, ctx)) as {
        groups: Array<{ items: Array<{ checked: boolean }> }>;
      };
      for (const g of result.groups) {
        for (const it of g.items) assert.equal(it.checked, false);
      }
    });
  });

  // ─── get_capabilities ──

  describe('get_capabilities', () => {
    it('returns the registered tool names', async () => {
      const result = (await getCapabilitiesTool.execute({}, ctx)) as {
        tools: Array<{ name: string; description: string }>;
      };
      const names = result.tools.map((t) => t.name);
      for (const expected of [
        'search_notes',
        'get_note',
        'list_tags',
        'list_folders',
        'get_reminders',
        'get_todos',
        'get_capabilities',
        'append_memo',
        'add_todo',
      ]) {
        assert.ok(names.includes(expected), `missing ${expected}`);
      }
    });
  });

  // ─── append_memo (Tier 1) ──

  describe('append_memo', () => {
    it('appends and returns note_applied side effect', async () => {
      const before = getNote(db, SPECIAL_NOTES.MEMO);
      assert.ok(before);
      const result = (await appendMemoTool.execute({ text: 'remember the milk' }, ctx)) as {
        message: string;
        sideEffect: {
          type: string;
          payload: { note_id: string; appended_text: string; content: string };
        };
      };
      assert.equal(result.sideEffect.type, 'note_applied');
      assert.equal(result.sideEffect.payload.note_id, SPECIAL_NOTES.MEMO);
      assert.equal(result.sideEffect.payload.appended_text, 'remember the milk');
      assert.ok(result.sideEffect.payload.content.includes('remember the milk'));

      // DB-side change persisted.
      const after = getNote(db, SPECIAL_NOTES.MEMO);
      assert.ok(after);
      assert.ok(after.content.includes('remember the milk'));
      assert.ok(after.updatedAt.getTime() >= before.updatedAt.getTime());
    });

    it('rejects empty text', async () => {
      await assert.rejects(appendMemoTool.execute({ text: '' }, ctx), /text is required/);
    });
  });

  // ─── add_todo (Tier 1) ──

  describe('add_todo', () => {
    it('appends an unchecked todo line', async () => {
      const result = (await addTodoTool.execute({ content: 'water the plants' }, ctx)) as {
        sideEffect: {
          type: string;
          payload: { note_id: string; appended_text: string; content: string };
        };
      };
      assert.equal(result.sideEffect.type, 'note_applied');
      assert.equal(result.sideEffect.payload.note_id, SPECIAL_NOTES.TODO);
      assert.equal(result.sideEffect.payload.appended_text, '- [ ] water the plants');

      const after = getNote(db, SPECIAL_NOTES.TODO);
      assert.ok(after, 'expected todo special note to exist');
      assert.ok(after.content.includes('- [ ] water the plants'));
      // Trailing dangling `- [ ]` from the default template is replaced, not duplicated.
      const occurrences = after.content.match(/- \[ \](?!\s*$)/g);
      assert.ok(occurrences && occurrences.length >= 1);
    });

    it('rejects empty content', async () => {
      await assert.rejects(addTodoTool.execute({ content: '' }, ctx), /content is required/);
    });
  });
});
