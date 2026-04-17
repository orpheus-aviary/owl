import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type OwlConfig,
  createConsoleLogger,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
} from '@owl/core';
import type { OwlDatabase } from '@owl/core';
import type Database from 'better-sqlite3';
import { ConversationStore } from './ai/conversations.js';
import { PreviewStore } from './ai/preview-store.js';
import { createBuiltinRegistry } from './ai/tools/index.js';
import { ReminderScheduler } from './scheduler.js';
import { buildServer } from './server.js';

const TEST_DIR = join(tmpdir(), `owl-daemon-test-${Date.now()}`);
const TEST_CONFIG_PATH = join(TEST_DIR, 'owl_config.toml');

describe('daemon API', () => {
  let app: ReturnType<typeof buildServer>;
  let db: OwlDatabase;
  let sqlite: Database.Database;
  let scheduler: ReminderScheduler;
  // Live config object shared with the server so PATCH /config mutations are visible.
  let ctxConfig: OwlConfig;

  before(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
    ensureSpecialNotes(db);
    const deviceId = ensureDeviceId(db);

    const logger = createConsoleLogger('test', 'silent');
    ctxConfig = structuredClone(DEFAULT_CONFIG);
    scheduler = new ReminderScheduler(db, sqlite, ctxConfig, logger);
    app = buildServer({
      db,
      sqlite,
      config: ctxConfig,
      configPath: TEST_CONFIG_PATH,
      logger,
      deviceId,
      scheduler,
      toolRegistry: createBuiltinRegistry(),
      conversationStore: new ConversationStore(),
      previewStore: new PreviewStore(),
    });
    await app.ready();
  });

  after(async () => {
    // Stop scheduler first — its internal setTimeout for pending reminders
    // (scheduled 1-2 hours out by the alarm integration tests below) keeps
    // the Node.js event loop alive and prevents the test process from exiting.
    scheduler.stop();
    await app.close();
    sqlite.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Status ──

  it('GET /status returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/status' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.status, 'ok');
  });

  it('GET /api/capabilities lists endpoints', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.data.endpoints.length > 0);
  });

  // ── Notes CRUD ──

  let noteId: string;

  it('POST /notes creates a note', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notes',
      payload: { content: '# API Test\n\nHello from test', tags: ['#test', '#api'] },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.success, true);
    assert.ok(body.data.id);
    assert.equal(body.data.tags.length, 2);
    noteId = body.data.id;
  });

  it('GET /notes/:id returns the note', async () => {
    const res = await app.inject({ method: 'GET', url: `/notes/${noteId}` });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.id, noteId);
    assert.equal(body.data.content, '# API Test\n\nHello from test');
  });

  it('GET /notes lists notes', async () => {
    const res = await app.inject({ method: 'GET', url: '/notes' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.data.length >= 1);
    assert.ok(body.total >= 1);
  });

  it('PUT /notes/:id updates note', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/notes/${noteId}`,
      payload: { content: 'Updated content' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.content, 'Updated content');
  });

  it('PATCH /notes/:id partial update', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/notes/${noteId}`,
      payload: { tags: ['#patched'] },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.tags.length, 1);
    assert.equal(res.json().data.tags[0].tagValue, 'patched');
  });

  it('DELETE /notes/:id soft deletes', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/notes/${noteId}` });
    assert.equal(res.statusCode, 200);

    const getRes = await app.inject({ method: 'GET', url: `/notes/${noteId}` });
    assert.equal(getRes.json().data.trashLevel, 1);
  });

  it('POST /notes/:id/restore restores', async () => {
    const res = await app.inject({ method: 'POST', url: `/notes/${noteId}/restore` });
    assert.equal(res.statusCode, 200);

    const getRes = await app.inject({ method: 'GET', url: `/notes/${noteId}` });
    assert.equal(getRes.json().data.trashLevel, 0);
  });

  it('DELETE /notes/:id returns 403 for special notes', async () => {
    const MEMO = '00000000-0000-0000-0000-000000000001';
    const res = await app.inject({ method: 'DELETE', url: `/notes/${MEMO}` });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error_code, 'SPECIAL_NOTE_PROTECTED');
  });

  it('POST /notes/:id/permanent-delete returns 403 for special notes', async () => {
    const MEMO = '00000000-0000-0000-0000-000000000001';
    const res = await app.inject({
      method: 'POST',
      url: `/notes/${MEMO}/permanent-delete`,
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error_code, 'SPECIAL_NOTE_PROTECTED');
  });

  it('POST /notes/:id/permanent-delete removes permanently', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/notes/${noteId}/permanent-delete`,
    });
    assert.equal(res.statusCode, 200);

    const getRes = await app.inject({ method: 'GET', url: `/notes/${noteId}` });
    assert.equal(getRes.statusCode, 404);
  });

  // ── Batch ──

  it('POST /notes/batch-delete and batch-restore', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/notes', payload: { content: 'Batch A' } });
    const r2 = await app.inject({ method: 'POST', url: '/notes', payload: { content: 'Batch B' } });
    const ids = [r1.json().data.id, r2.json().data.id];

    const delRes = await app.inject({
      method: 'POST',
      url: '/notes/batch-delete',
      payload: { ids },
    });
    assert.equal(delRes.json().data.count, 2);

    const restoreRes = await app.inject({
      method: 'POST',
      url: '/notes/batch-restore',
      payload: { ids },
    });
    assert.equal(restoreRes.json().data.count, 2);
  });

  // ── Tags ──

  it('GET /tags returns hashtags', async () => {
    // Create a note with tags first
    await app.inject({
      method: 'POST',
      url: '/notes',
      payload: { content: 'Tag test', tags: ['#tagtest'] },
    });

    const res = await app.inject({ method: 'GET', url: '/tags' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().data.length > 0);
  });

  it('POST /parse-tag parses tag string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/parse-tag',
      payload: { raw: '#hello' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.tagType, '#');
    assert.equal(res.json().data.tagValue, 'hello');
  });

  // ── Reminders/Alarms ──

  it('GET /reminders/alarms returns only alarm notes', async () => {
    // Create a note with /alarm tag
    const r1 = await app.inject({
      method: 'POST',
      url: '/notes',
      payload: { content: 'Alarm note', tags: ['/alarm:2026-04-11T10:00:00'] },
    });
    assert.equal(r1.statusCode, 201);
    const alarmNoteId = r1.json().data.id;

    // Create a note without /alarm tag
    await app.inject({
      method: 'POST',
      url: '/notes',
      payload: { content: 'Normal note', tags: ['#regular'] },
    });

    // Fetch alarms
    const res = await app.inject({ method: 'GET', url: '/reminders/alarms' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.data));

    // Should contain our alarm note
    const alarmNote = body.data.find((n: { id: string }) => n.id === alarmNoteId);
    assert.ok(alarmNote, 'alarm note should be in results');
    assert.ok(Array.isArray(alarmNote.tags), 'note should have tags array');
    assert.ok(
      alarmNote.tags.some((t: { tagType: string }) => t.tagType === '/alarm'),
      'should have /alarm tag',
    );

    // Should NOT contain notes without /alarm tags (check none of the results lack /alarm)
    for (const note of body.data) {
      assert.ok(
        note.tags.some((t: { tagType: string }) => t.tagType === '/alarm'),
        `note ${note.id} should have /alarm tag`,
      );
    }
  });

  // ── Reminder scheduler integration ──

  describe('reminder scheduler integration', () => {
    const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
    const makeAlarmTag = (offsetMs: number) => {
      const d = new Date(Date.now() + offsetMs);
      return `/alarm ${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    it('POST /notes with /alarm tag creates pending reminder_status', async () => {
      const alarmTag = makeAlarmTag(3600_000); // 1 hour
      const res = await app.inject({
        method: 'POST',
        url: '/notes',
        payload: { content: 'Alarm integration test', tags: [alarmTag] },
      });
      assert.equal(res.statusCode, 201);
      const id = res.json().data.id;

      const rows = sqlite.prepare('SELECT * FROM reminder_status WHERE note_id = ?').all(id) as {
        note_id: string;
        status: string;
      }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'pending');
    });

    it('PUT /notes/:id updating alarm tag updates reminder_status', async () => {
      const alarmTag1 = makeAlarmTag(3600_000); // 1 hour
      const r1 = await app.inject({
        method: 'POST',
        url: '/notes',
        payload: { content: 'Alarm update test', tags: [alarmTag1] },
      });
      const id = r1.json().data.id;

      const before = sqlite
        .prepare('SELECT fire_at FROM reminder_status WHERE note_id = ?')
        .all(id) as { fire_at: number }[];
      assert.equal(before.length, 1);
      const fireAtBefore = before[0].fire_at;

      const alarmTag2 = makeAlarmTag(7200_000); // 2 hours
      await app.inject({
        method: 'PUT',
        url: `/notes/${id}`,
        payload: { content: 'Alarm update test', tags: [alarmTag2] },
      });

      const after = sqlite
        .prepare('SELECT fire_at FROM reminder_status WHERE note_id = ?')
        .all(id) as { fire_at: number }[];
      assert.equal(after.length, 1);
      assert.notEqual(after[0].fire_at, fireAtBefore, 'fire_at should have changed');
    });

    it('PUT /notes/:id removing alarm tag removes reminder_status', async () => {
      const alarmTag = makeAlarmTag(3600_000);
      const r1 = await app.inject({
        method: 'POST',
        url: '/notes',
        payload: { content: 'Alarm remove test', tags: [alarmTag] },
      });
      const id = r1.json().data.id;

      // Verify reminder exists
      const before = sqlite.prepare('SELECT * FROM reminder_status WHERE note_id = ?').all(id);
      assert.equal(before.length, 1);

      // Update with no tags
      await app.inject({
        method: 'PUT',
        url: `/notes/${id}`,
        payload: { content: 'Alarm remove test', tags: [] },
      });

      const after = sqlite.prepare('SELECT * FROM reminder_status WHERE note_id = ?').all(id);
      assert.equal(after.length, 0);
    });

    it('permanent delete cascades to reminder_status', async () => {
      const alarmTag = makeAlarmTag(3600_000);
      const r1 = await app.inject({
        method: 'POST',
        url: '/notes',
        payload: { content: 'Alarm cascade test', tags: [alarmTag] },
      });
      const id = r1.json().data.id;

      // Verify reminder exists
      const before = sqlite.prepare('SELECT * FROM reminder_status WHERE note_id = ?').all(id);
      assert.equal(before.length, 1);

      // Permanent delete
      await app.inject({
        method: 'POST',
        url: `/notes/${id}/permanent-delete`,
      });

      const after = sqlite.prepare('SELECT * FROM reminder_status WHERE note_id = ?').all(id);
      assert.equal(after.length, 0);
    });
  });

  // ── Todos ──

  describe('todos', () => {
    let todoNoteId: string;
    let emptyNoteId: string;

    it('creates a note with todos for todo tests', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/notes',
        payload: {
          content: [
            '# Shopping',
            '',
            '- [ ] 买菜',
            '- [x] 打扫卫生',
            '- [ ] 写报告',
            '',
            '备注：周末完成',
          ].join('\n'),
        },
      });
      assert.equal(res.statusCode, 201);
      todoNoteId = res.json().data.id;

      const empty = await app.inject({
        method: 'POST',
        url: '/notes',
        payload: { content: '# No todos here\n\njust a note' },
      });
      emptyNoteId = empty.json().data.id;
    });

    it('GET /todos?checked=false returns only open todos', async () => {
      const res = await app.inject({ method: 'GET', url: '/todos?checked=false' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.success, true);

      const group = body.data.find((g: { note_id: string }) => g.note_id === todoNoteId);
      assert.ok(group, 'todo note should be in results');
      assert.equal(group.items.length, 2, 'should return 2 unchecked items');
      assert.ok(group.items.every((it: { checked: boolean }) => !it.checked));

      // Note without todos should not appear
      const emptyGroup = body.data.find((g: { note_id: string }) => g.note_id === emptyNoteId);
      assert.equal(emptyGroup, undefined);
    });

    it('GET /todos (no filter) returns all todos', async () => {
      const res = await app.inject({ method: 'GET', url: '/todos' });
      assert.equal(res.statusCode, 200);
      const group = res.json().data.find((g: { note_id: string }) => g.note_id === todoNoteId);
      assert.ok(group);
      assert.equal(group.items.length, 3, 'should include checked and unchecked');
      assert.equal(group.items[0].text, '买菜');
      assert.equal(group.items[0].checked, false);
      assert.equal(group.items[1].text, '打扫卫生');
      assert.equal(group.items[1].checked, true);
    });

    it('PATCH /notes/:id/toggle-todo flips an unchecked item', async () => {
      // Line 3 in the content is "- [ ] 买菜"
      const res = await app.inject({
        method: 'PATCH',
        url: `/notes/${todoNoteId}/toggle-todo`,
        payload: { line: 3 },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().data.content.includes('- [x] 买菜'));
    });

    it('PATCH /notes/:id/toggle-todo flips it back', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/notes/${todoNoteId}/toggle-todo`,
        payload: { line: 3 },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().data.content.includes('- [ ] 买菜'));
    });

    it('PATCH /notes/:id/toggle-todo rejects non-todo lines', async () => {
      // Line 1 is "# Shopping" (a heading, not a todo)
      const res = await app.inject({
        method: 'PATCH',
        url: `/notes/${todoNoteId}/toggle-todo`,
        payload: { line: 1 },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error_code, 'NOT_A_TODO');
    });

    it('PATCH /notes/:id/toggle-todo rejects out-of-range lines', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/notes/${todoNoteId}/toggle-todo`,
        payload: { line: 9999 },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error_code, 'INVALID_LINE');
    });

    it('PATCH /notes/:id/toggle-todo returns 404 for missing note', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/notes/does-not-exist/toggle-todo',
        payload: { line: 1 },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  // ── Config ──

  describe('config', () => {
    it('GET /config returns current config', async () => {
      const res = await app.inject({ method: 'GET', url: '/config' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.shortcuts.save, 'Mod-KeyS');
      assert.equal(body.data.daemon.port, 47010);
    });

    it('PATCH /config deep-merges and persists shortcuts', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/config',
        payload: { shortcuts: { save: 'Mod-Alt-KeyS' } },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.shortcuts.save, 'Mod-Alt-KeyS');
      // Untouched fields still present
      assert.equal(res.json().data.shortcuts.close_tab, 'Mod-KeyW');
      // Persisted to disk
      const raw = readFileSync(TEST_CONFIG_PATH, 'utf-8');
      assert.ok(raw.includes('Mod-Alt-KeyS'));
    });

    it('PATCH /config rejects non-whitelisted sections', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/config',
        payload: { daemon: { port: 1 }, shortcuts: { save: 'Mod-KeyS' } },
      });
      assert.equal(res.statusCode, 200);
      // daemon section was filtered out, port should remain unchanged
      assert.equal(ctxConfig.daemon.port, 47010);
      assert.equal(res.json().data.shortcuts.save, 'Mod-KeyS');
    });

    it('PATCH /config rejects non-object body', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/config',
        headers: { 'content-type': 'application/json' },
        payload: '"a string"',
      });
      assert.equal(res.statusCode, 400);
    });

    it('PATCH /config rejects invalid trash.auto_delete_days', async () => {
      for (const bad of [0, -1, 3651, 1.5, '7', null]) {
        const res = await app.inject({
          method: 'PATCH',
          url: '/config',
          payload: { trash: { auto_delete_days: bad } },
        });
        assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(bad)}`);
        assert.equal(res.json().error_code, 'INVALID_CONFIG');
      }
      // Boundary-legal values pass.
      for (const good of [1, 3650, 30]) {
        const res = await app.inject({
          method: 'PATCH',
          url: '/config',
          payload: { trash: { auto_delete_days: good } },
        });
        assert.equal(res.statusCode, 200, `expected 200 for ${good}`);
      }
      // Leave auto_delete_days at 30 for subsequent tests.
      assert.equal(ctxConfig.trash.auto_delete_days, 30);
    });

    it('PATCH /config trash pulls existing deadlines earlier but never extends them', async () => {
      // Create a note, soft-delete it twice to land in level 2. The default
      // threshold is 30, so auto_delete_at ≈ now + 30d.
      const create = await app.inject({
        method: 'POST',
        url: '/notes',
        payload: { content: 'trash ttl test' },
      });
      const id = create.json().data.id;
      await app.inject({ method: 'DELETE', url: `/notes/${id}` }); // level 1
      await app.inject({ method: 'DELETE', url: `/notes/${id}` }); // level 2
      const afterDelete = await app.inject({ method: 'GET', url: `/notes/${id}` });
      const initialDeadline = new Date(afterDelete.json().data.autoDeleteAt).getTime();
      const now = Date.now();
      assert.ok(initialDeadline >= now + 29 * 86_400_000);
      assert.ok(initialDeadline <= now + 31 * 86_400_000);

      // Lower threshold to 7 — deadline should come in
      await app.inject({
        method: 'PATCH',
        url: '/config',
        payload: { trash: { auto_delete_days: 7 } },
      });
      const afterLower = await app.inject({ method: 'GET', url: `/notes/${id}` });
      const loweredDeadline = new Date(afterLower.json().data.autoDeleteAt).getTime();
      assert.ok(loweredDeadline <= Date.now() + 7 * 86_400_000 + 5000);

      // Raise back to 30 — deadline must NOT extend
      await app.inject({
        method: 'PATCH',
        url: '/config',
        payload: { trash: { auto_delete_days: 30 } },
      });
      const afterRaise = await app.inject({ method: 'GET', url: `/notes/${id}` });
      const raisedDeadline = new Date(afterRaise.json().data.autoDeleteAt).getTime();
      assert.equal(raisedDeadline, loweredDeadline);

      // Permanently delete to clean up
      await app.inject({ method: 'POST', url: `/notes/${id}/permanent-delete` });
    });
  });

  // ── Error handling ──

  it('returns 404 for non-existent note', async () => {
    const res = await app.inject({ method: 'GET', url: '/notes/non-existent' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().success, false);
  });

  it('returns 400 for missing content', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/notes',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  // ── Folders ──

  describe('folders CRUD', () => {
    it('creates, lists, renames, moves, deletes folders', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/folders',
        payload: { name: 'Parent' },
      });
      assert.equal(createRes.statusCode, 201);
      const parent = createRes.json().data;

      const childRes = await app.inject({
        method: 'POST',
        url: '/folders',
        payload: { name: 'Child', parent_id: parent.id },
      });
      const child = childRes.json().data;
      assert.equal(child.parent_id, parent.id);
      assert.equal(child.position, 0);

      // Rename
      const renameRes = await app.inject({
        method: 'PUT',
        url: `/folders/${child.id}`,
        payload: { name: 'Renamed' },
      });
      assert.equal(renameRes.json().data.name, 'Renamed');

      // List (flat)
      const listRes = await app.inject({ method: 'GET', url: '/folders' });
      const all = listRes.json().data as { id: string }[];
      assert.ok(all.some((f) => f.id === parent.id));
      assert.ok(all.some((f) => f.id === child.id));

      // Create a note in the child and verify include_descendants=true/false
      const noteRes = await app.inject({
        method: 'POST',
        url: '/notes',
        payload: { content: 'note in child', folder_id: child.id },
      });
      const note = noteRes.json().data;

      const recursive = await app.inject({
        method: 'GET',
        url: `/notes?folder_id=${parent.id}`,
      });
      assert.ok((recursive.json().data as { id: string }[]).some((n) => n.id === note.id));

      const exact = await app.inject({
        method: 'GET',
        url: `/notes?folder_id=${parent.id}&include_descendants=false`,
      });
      assert.ok(!(exact.json().data as { id: string }[]).some((n) => n.id === note.id));

      // Move note via PATCH /notes/:id/move
      const moveRes = await app.inject({
        method: 'PATCH',
        url: `/notes/${note.id}/move`,
        payload: { folder_id: parent.id },
      });
      assert.equal(moveRes.statusCode, 200);
      assert.equal(moveRes.json().data.folderId, parent.id);

      // Delete child (parent still exists); note was moved so nothing to promote
      const delRes = await app.inject({ method: 'DELETE', url: `/folders/${child.id}` });
      assert.equal(delRes.statusCode, 200);

      // Delete parent and verify the note's folder_id is reset to null
      await app.inject({ method: 'DELETE', url: `/folders/${parent.id}` });
      const reloaded = await app.inject({ method: 'GET', url: `/notes/${note.id}` });
      assert.equal(reloaded.json().data.folderId, null);

      // Clean up
      await app.inject({ method: 'POST', url: `/notes/${note.id}/permanent-delete` });
    });

    it('promotes children to grandparent when a middle folder is deleted', async () => {
      const root = (
        await app.inject({ method: 'POST', url: '/folders', payload: { name: 'R' } })
      ).json().data;
      const mid = (
        await app.inject({
          method: 'POST',
          url: '/folders',
          payload: { name: 'M', parent_id: root.id },
        })
      ).json().data;
      const leaf = (
        await app.inject({
          method: 'POST',
          url: '/folders',
          payload: { name: 'L', parent_id: mid.id },
        })
      ).json().data;

      await app.inject({ method: 'DELETE', url: `/folders/${mid.id}` });

      const list = (await app.inject({ method: 'GET', url: '/folders' })).json().data as {
        id: string;
        parent_id: string | null;
      }[];
      const leafRow = list.find((f) => f.id === leaf.id);
      assert.equal(leafRow?.parent_id, root.id);

      // Clean up
      await app.inject({ method: 'DELETE', url: `/folders/${leaf.id}` });
      await app.inject({ method: 'DELETE', url: `/folders/${root.id}` });
    });

    it('rejects creating folder with missing name', async () => {
      const res = await app.inject({ method: 'POST', url: '/folders', payload: { name: '' } });
      assert.equal(res.statusCode, 400);
    });

    it('rejects moving a folder into its own descendant', async () => {
      const p = (
        await app.inject({ method: 'POST', url: '/folders', payload: { name: 'P' } })
      ).json().data;
      const c = (
        await app.inject({
          method: 'POST',
          url: '/folders',
          payload: { name: 'C', parent_id: p.id },
        })
      ).json().data;
      const res = await app.inject({
        method: 'PUT',
        url: `/folders/${p.id}`,
        payload: { parent_id: c.id },
      });
      assert.equal(res.statusCode, 400);

      await app.inject({ method: 'DELETE', url: `/folders/${c.id}` });
      await app.inject({ method: 'DELETE', url: `/folders/${p.id}` });
    });

    it('reorders folders in batch', async () => {
      const a = (
        await app.inject({ method: 'POST', url: '/folders', payload: { name: 'RA' } })
      ).json().data;
      const b = (
        await app.inject({ method: 'POST', url: '/folders', payload: { name: 'RB' } })
      ).json().data;

      const res = await app.inject({
        method: 'PATCH',
        url: '/folders/reorder',
        payload: {
          items: [
            { id: a.id, parent_id: null, position: 100 },
            { id: b.id, parent_id: null, position: 101 },
          ],
        },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.count, 2);

      await app.inject({ method: 'DELETE', url: `/folders/${a.id}` });
      await app.inject({ method: 'DELETE', url: `/folders/${b.id}` });
    });
  });
});
