import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  createConsoleLogger,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
} from '@owl/core';
import type { OwlDatabase } from '@owl/core';
import type Database from 'better-sqlite3';
import { ReminderScheduler } from './scheduler.js';
import { buildServer } from './server.js';

describe('daemon API', () => {
  let app: ReturnType<typeof buildServer>;
  let db: OwlDatabase;
  let sqlite: Database.Database;
  let scheduler: ReminderScheduler;

  before(async () => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
    ensureSpecialNotes(db);
    const deviceId = ensureDeviceId(db);

    const logger = createConsoleLogger('test', 'silent');
    scheduler = new ReminderScheduler(db, sqlite, logger);
    app = buildServer({
      db,
      sqlite,
      config: DEFAULT_CONFIG,
      logger,
      deviceId,
      scheduler,
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
});
