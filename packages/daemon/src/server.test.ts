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

  before(async () => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
    ensureSpecialNotes(db);
    const deviceId = ensureDeviceId(db);

    const logger = createConsoleLogger('test', 'silent');
    const scheduler = new ReminderScheduler(db, sqlite, logger);
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
