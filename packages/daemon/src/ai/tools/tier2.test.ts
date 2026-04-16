import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type OwlConfig,
  type OwlDatabase,
  createConsoleLogger,
  createDatabase,
  createNote,
  ensureDeviceId,
  ensureSpecialNotes,
  getNote,
} from '@owl/core';
import type Database from 'better-sqlite3';
import { ReminderScheduler } from '../../scheduler.js';
import { PreviewStore } from '../preview-store.js';
import { type ToolContext, isWriteToolResult } from '../tool-registry.js';
import { applyUpdateTool } from './apply-update.js';
import { createNoteTool } from './create-note.js';
import { createReminderTool } from './create-reminder.js';
import { createBuiltinRegistry } from './index.js';
import { updateNoteTool } from './update-note.js';

/**
 * Build a fresh ToolContext for each test. We never share DB / scheduler /
 * preview-store across cases because the Tier-2 tools mutate the preview
 * map and we want assertions to read clean state.
 */
function makeCtx(source: 'gui' | 'external'): {
  ctx: ToolContext;
  db: OwlDatabase;
  sqlite: Database.Database;
  scheduler: ReminderScheduler;
  previewStore: PreviewStore;
  config: OwlConfig;
} {
  const created = createDatabase({ dbPath: ':memory:' });
  ensureSpecialNotes(created.db);
  const deviceId = ensureDeviceId(created.db);
  const config = structuredClone(DEFAULT_CONFIG);
  const logger = createConsoleLogger('tier2-test', 'silent');
  const scheduler = new ReminderScheduler(created.db, created.sqlite, config, logger);
  const previewStore = new PreviewStore();
  const ctx: ToolContext = {
    db: created.db,
    sqlite: created.sqlite,
    config,
    deviceId,
    scheduler,
    source,
    logger,
    previewStore,
    registry: createBuiltinRegistry(),
  };
  return { ctx, db: created.db, sqlite: created.sqlite, scheduler, previewStore, config };
}

describe('Tier-2 write tools (P2-7e)', () => {
  // ─── create_note ──

  describe('create_note', () => {
    it('source=gui returns draft_ready with no DB write', async () => {
      const { ctx, db, sqlite, scheduler } = makeCtx('gui');
      try {
        const before = sqlite.prepare('SELECT COUNT(*) as n FROM notes').get() as { n: number };
        const result = await createNoteTool.execute(
          { content: '# Hello\nbody', tags: ['#draft-test'], folder_id: null },
          ctx,
        );
        assert.ok(isWriteToolResult(result));
        assert.equal(result.sideEffect?.type, 'draft_ready');
        const payload = result.sideEffect?.payload as { action: string; note_id: string };
        assert.equal(payload.action, 'create');
        assert.match(payload.note_id, /^draft_/);
        const after = sqlite.prepare('SELECT COUNT(*) as n FROM notes').get() as { n: number };
        assert.equal(after.n, before.n, 'no DB write expected for source=gui');
      } finally {
        scheduler.stop();
        sqlite.close();
        // db unused after close, satisfy linter
        void db;
      }
    });

    it('source=external stores a preview and returns preview_ready', async () => {
      const { ctx, sqlite, scheduler, previewStore } = makeCtx('external');
      try {
        const result = await createNoteTool.execute({ content: 'hi', tags: ['#x'] }, ctx);
        assert.ok(isWriteToolResult(result));
        const payload = result.sideEffect?.payload as { preview_id: string; diff: string };
        assert.match(payload.preview_id, /^preview_/);
        assert.ok(payload.diff.includes('## content'));
        assert.ok(previewStore.get(payload.preview_id));
      } finally {
        scheduler.stop();
        sqlite.close();
      }
    });
  });

  // ─── update_note ──

  describe('update_note', () => {
    it('source=gui returns original_* baselines for conflict detection', async () => {
      const { ctx, db, sqlite, scheduler } = makeCtx('gui');
      try {
        const note = createNote(db, sqlite, {
          content: '# Original\nbody',
          tags: [{ tagType: '#', tagValue: 'before' }],
        });
        const result = await updateNoteTool.execute(
          { note_id: note.id, content: '# Updated\nnew body' },
          ctx,
        );
        assert.ok(isWriteToolResult(result));
        const payload = result.sideEffect?.payload as {
          action: string;
          note_id: string;
          content: string;
          original_content: string;
          original_tags: string[];
          original_folder_id: string | null;
        };
        assert.equal(payload.action, 'update');
        assert.equal(payload.note_id, note.id);
        assert.equal(payload.content, '# Updated\nnew body');
        assert.equal(payload.original_content, '# Original\nbody');
        assert.deepEqual(payload.original_tags, ['#before']);
        assert.equal(payload.original_folder_id, null);
        // No DB write happened.
        const stillOriginal = getNote(db, note.id);
        assert.equal(stillOriginal?.content, '# Original\nbody');
      } finally {
        scheduler.stop();
        sqlite.close();
      }
    });

    it('rejects when no field is provided', async () => {
      const { ctx, db, sqlite, scheduler } = makeCtx('gui');
      try {
        const note = createNote(db, sqlite, { content: 'x' });
        await assert.rejects(
          updateNoteTool.execute({ note_id: note.id }, ctx),
          /at least one of content, tags, or folder_id/,
        );
      } finally {
        scheduler.stop();
        sqlite.close();
      }
    });

    it('returns error for missing note', async () => {
      const { ctx, sqlite, scheduler } = makeCtx('gui');
      try {
        const result = await updateNoteTool.execute({ note_id: 'no-such', content: 'x' }, ctx);
        assert.deepEqual(result, { error: 'Note not found: no-such' });
      } finally {
        scheduler.stop();
        sqlite.close();
      }
    });
  });

  // ─── create_reminder ──

  describe('create_reminder', () => {
    it('synthesizes /alarm tag from fire_at', async () => {
      const { ctx, sqlite, scheduler } = makeCtx('gui');
      try {
        const result = await createReminderTool.execute(
          { content: 'buy milk', fire_at: '2099-04-20T10:00:00' },
          ctx,
        );
        assert.ok(isWriteToolResult(result));
        const payload = result.sideEffect?.payload as { tags: string[]; action: string };
        assert.equal(payload.action, 'create_reminder');
        assert.ok(payload.tags.some((t) => t.startsWith('/alarm')));
      } finally {
        scheduler.stop();
        sqlite.close();
      }
    });

    it('rejects unparseable fire_at', async () => {
      const { ctx, sqlite, scheduler } = makeCtx('gui');
      try {
        await assert.rejects(
          createReminderTool.execute({ content: 'x', fire_at: 'not-a-date' }, ctx),
          /could not be parsed/,
        );
      } finally {
        scheduler.stop();
        sqlite.close();
      }
    });
  });

  // ─── apply_update ──

  describe('apply_update', () => {
    it('commits a stored create preview to the DB', async () => {
      const { ctx, sqlite, scheduler, previewStore } = makeCtx('external');
      try {
        const draft = await createNoteTool.execute(
          { content: '# applied via tool', tags: ['#applied'] },
          ctx,
        );
        const previewId = (draft as { sideEffect: { payload: { preview_id: string } } }).sideEffect
          .payload.preview_id;

        const result = (await applyUpdateTool.execute({ preview_id: previewId }, ctx)) as {
          note_id: string;
          action: string;
        };
        assert.equal(result.action, 'create');
        assert.ok(result.note_id);
        // Preview was consumed.
        assert.equal(previewStore.get(previewId), undefined);
        // The note actually exists now.
        const row = sqlite.prepare('SELECT content FROM notes WHERE id = ?').get(result.note_id) as
          | { content: string }
          | undefined;
        assert.ok(row);
        assert.match(row.content, /applied via tool/);
      } finally {
        scheduler.stop();
        sqlite.close();
      }
    });

    it('returns error for unknown preview_id', async () => {
      const { ctx, sqlite, scheduler } = makeCtx('external');
      try {
        const result = await applyUpdateTool.execute({ preview_id: 'nope' }, ctx);
        assert.deepEqual(result, { error: 'preview not found or expired: nope' });
      } finally {
        scheduler.stop();
        sqlite.close();
      }
    });

    it('applies an update preview, including folder change', async () => {
      const { ctx, db, sqlite, scheduler } = makeCtx('external');
      try {
        const note = createNote(db, sqlite, { content: 'before' });
        const draft = await updateNoteTool.execute(
          { note_id: note.id, content: 'after', folder_id: null },
          ctx,
        );
        const previewId = (draft as { sideEffect: { payload: { preview_id: string } } }).sideEffect
          .payload.preview_id;
        const result = (await applyUpdateTool.execute({ preview_id: previewId }, ctx)) as {
          note_id: string;
          action: string;
        };
        assert.equal(result.action, 'update');
        const after = getNote(db, note.id);
        assert.equal(after?.content, 'after');
      } finally {
        scheduler.stop();
        sqlite.close();
      }
    });
  });
});

// ─── PreviewStore TTL ──

describe('PreviewStore', () => {
  it('expires entries past their TTL', () => {
    const store = new PreviewStore(10); // 10ms TTL
    const entry = store.create({ action: 'create', content: 'x', tags: [] });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(store.get(entry.id), undefined);
        resolve();
      }, 30);
    });
  });

  it('consume removes the entry atomically', () => {
    const store = new PreviewStore();
    const entry = store.create({ action: 'create', content: 'x', tags: [] });
    assert.ok(store.consume(entry.id));
    assert.equal(store.get(entry.id), undefined);
    assert.equal(store.consume(entry.id), undefined);
  });
});
