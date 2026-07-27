/**
 * P5-c Step 13 — conflict HTTP routes unit tests.
 *
 * Seeds rows directly into `conflict_record` (skipping `runSync` since the
 * detection path is already covered in core engine.test). Asserts that
 * GET /conflicts + GET /conflicts/count + POST /conflicts/:id/ignore have
 * the contract the GUI expects, and that the ignore route emits
 * `conflicts:changed` on success.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type NoteWithTags,
  type OwlDatabase,
  createConsoleLogger,
  createDatabase,
  createNote,
  ensureDeviceId,
  getNote,
  recordConflict,
} from '@owl/core';
import type Database from 'better-sqlite3';
import { ConversationStore } from '../ai/conversations.js';
import { PreviewStore } from '../ai/preview-store.js';
import { createBuiltinRegistry } from '../ai/tools/index.js';
import { EventsBus } from '../events/bus.js';
import type { OwlEvent } from '../events/types.js';
import { ReminderScheduler } from '../scheduler.js';
import { buildTestServer } from '../testing/build-test-server.js';

describe('conflicts routes (P5-c Step 13)', () => {
  let app: ReturnType<typeof buildTestServer>;
  let db: OwlDatabase;
  let sqlite: Database.Database;
  let scheduler: ReminderScheduler;
  let eventsBus: EventsBus;
  let captured: OwlEvent[];

  before(async () => {
    const created = createDatabase({ dbPath: ':memory:' });
    db = created.db;
    sqlite = created.sqlite;
    const deviceId = ensureDeviceId(db);

    const logger = createConsoleLogger('conflicts-route-test', 'silent');
    const config = structuredClone(DEFAULT_CONFIG);
    scheduler = new ReminderScheduler(db, sqlite, config, logger);
    eventsBus = new EventsBus();
    eventsBus.subscribe((event) => {
      captured.push(event);
    });

    app = buildTestServer({
      db,
      sqlite,
      config,
      logger,
      deviceId,
      scheduler,
      toolRegistry: createBuiltinRegistry(),
      conversationStore: new ConversationStore(sqlite),
      previewStore: new PreviewStore(),
      eventsBus,
      skybridgeSession: null,
    });
    await app.ready();
  });

  beforeEach(() => {
    sqlite.prepare('DELETE FROM conflict_record').run();
    captured = [];
  });

  after(async () => {
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  function seedConflict(id: string, entityId: string, detectedAt: number): string {
    return recordConflict(sqlite, {
      id,
      entityType: 'note',
      entityId,
      losingSide: 'local',
      localPayload: { content: `local-${entityId}`, updated_at_ms: detectedAt - 100 },
      remotePayload: { content: `remote-${entityId}`, updated_at_ms: detectedAt },
      localKey: { ms: detectedAt - 100, counter: 0, deviceId: 'dev-local' },
      remoteKey: { ms: detectedAt, counter: 0, deviceId: 'dev-remote' },
      nowMs: detectedAt,
    });
  }

  // ── GET /conflicts ──────────────────────────────────────────────

  describe('GET /conflicts', () => {
    it('returns unresolved rows newest-first with total', async () => {
      seedConflict('cr-a', 'note-a', 100);
      seedConflict('cr-b', 'note-b', 200);
      seedConflict('cr-c', 'note-c', 150);

      const res = await app.inject({ method: 'GET', url: '/conflicts' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.success, true);
      assert.equal(body.total, 3);
      const ids = (body.data.conflicts as { entity_id: string }[]).map((r) => r.entity_id);
      assert.deepEqual(ids, ['note-b', 'note-c', 'note-a']);
    });

    it('excludes resolved rows', async () => {
      seedConflict('cr-a', 'note-a', 100);
      seedConflict('cr-b', 'note-b', 200);
      sqlite
        .prepare(
          "UPDATE conflict_record SET resolved_at = 999, resolution = 'ignored' WHERE id = 'cr-a'",
        )
        .run();

      const res = await app.inject({ method: 'GET', url: '/conflicts' });
      const body = res.json();
      assert.equal(body.total, 1);
      assert.equal(body.data.conflicts[0].entity_id, 'note-b');
    });

    it('honors ?limit and clamps to MAX_LIMIT', async () => {
      for (let i = 0; i < 5; i++) seedConflict(`cr-${i}`, `note-${i}`, 100 + i);
      const small = await app.inject({ method: 'GET', url: '/conflicts?limit=2' });
      assert.equal(small.json().data.conflicts.length, 2);

      const huge = await app.inject({ method: 'GET', url: '/conflicts?limit=999' });
      assert.equal(huge.json().data.conflicts.length, 5);
    });

    it('400 USAGE_ERROR on invalid limit', async () => {
      const res = await app.inject({ method: 'GET', url: '/conflicts?limit=abc' });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error_code, 'USAGE_ERROR');
    });
  });

  // ── GET /conflicts/count ────────────────────────────────────────

  describe('GET /conflicts/count', () => {
    it('returns 0 on empty table', async () => {
      const res = await app.inject({ method: 'GET', url: '/conflicts/count' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.count, 0);
    });

    it('counts only unresolved rows', async () => {
      seedConflict('cr-a', 'note-a', 100);
      seedConflict('cr-b', 'note-b', 200);
      sqlite
        .prepare(
          "UPDATE conflict_record SET resolved_at = 999, resolution = 'ignored' WHERE id = 'cr-a'",
        )
        .run();
      const res = await app.inject({ method: 'GET', url: '/conflicts/count' });
      assert.equal(res.json().data.count, 1);
    });
  });

  // ── POST /conflicts/:id/ignore ──────────────────────────────────

  describe('POST /conflicts/:id/ignore', () => {
    it('soft-deletes (UPDATE resolved_at + resolution) and emits conflicts:changed', async () => {
      const id = seedConflict('cr-a', 'note-a', 100);
      const res = await app.inject({ method: 'POST', url: `/conflicts/${id}/ignore` });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.ignored, true);
      assert.equal(body.data.id, id);

      // Row still exists, resolved_at set, resolution='ignored'
      const row = sqlite
        .prepare('SELECT resolved_at, resolution FROM conflict_record WHERE id = ?')
        .get(id) as { resolved_at: number | null; resolution: string | null };
      assert.ok(row.resolved_at, 'resolved_at is stamped');
      assert.equal(row.resolution, 'ignored');

      // event emitted
      assert.equal(captured.length, 1);
      assert.equal(captured[0].type, 'conflicts:changed');
    });

    it('404 on unknown id (no event emitted)', async () => {
      const res = await app.inject({ method: 'POST', url: '/conflicts/unknown-id/ignore' });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error_code, 'CONFLICT_NOT_FOUND');
      assert.equal(captured.length, 0);
    });

    it('404 on already-resolved row (idempotent — no double emit)', async () => {
      const id = seedConflict('cr-a', 'note-a', 100);
      await app.inject({ method: 'POST', url: `/conflicts/${id}/ignore` });
      captured.length = 0; // discard first emit
      const second = await app.inject({ method: 'POST', url: `/conflicts/${id}/ignore` });
      assert.equal(second.statusCode, 404);
      assert.equal(captured.length, 0, 'second ignore must not re-emit');
    });
  });

  // ── POST /conflicts/:id/resolve (W7) ────────────────────────────

  describe('POST /conflicts/:id/resolve', () => {
    /** Seed a real note (remote/winning) + a conflict row whose local_payload
     *  carries a losing copy. Returns note + conflict id + CAS baseline. */
    function seedResolvable(
      remote: string,
      local: string,
    ): {
      note: NoteWithTags;
      conflictId: string;
      baseline: number;
    } {
      const note = createNote(db, sqlite, { content: remote });
      const conflictId = recordConflict(sqlite, {
        entityType: 'note',
        entityId: note.id,
        losingSide: 'local',
        localPayload: { content: local, updated_at_ms: 100 },
        remotePayload: { content: remote, updated_at_ms: 200 },
        localKey: { ms: 100, counter: 0, deviceId: 'dev-local' },
        remoteKey: { ms: 200, counter: 0, deviceId: 'dev-remote' },
      });
      return { note, conflictId, baseline: note.updatedAt.getTime() };
    }

    it('local strategy → 200 {resolved:true, note}, note overwritten, emits changed', async () => {
      const { note, conflictId, baseline } = seedResolvable('REMOTE', 'LOCAL');
      const res = await app.inject({
        method: 'POST',
        url: `/conflicts/${conflictId}/resolve`,
        payload: { strategy: 'local', expected_updated_at_ms: baseline },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.data.resolved, true);
      assert.equal(body.data.note.content, 'LOCAL');
      assert.equal(getNote(db, note.id)?.content, 'LOCAL');
      assert.ok(captured.some((e) => e.type === 'conflicts:changed'));
    });

    it('merged strategy → writes supplied content', async () => {
      const { note, conflictId, baseline } = seedResolvable('REMOTE', 'LOCAL');
      const res = await app.inject({
        method: 'POST',
        url: `/conflicts/${conflictId}/resolve`,
        payload: { strategy: 'merged', content: 'MERGED', expected_updated_at_ms: baseline },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().data.note.content, 'MERGED');
      assert.equal(getNote(db, note.id)?.content, 'MERGED');
    });

    it('merged empty string is legal', async () => {
      const { note, conflictId, baseline } = seedResolvable('REMOTE', 'LOCAL');
      const res = await app.inject({
        method: 'POST',
        url: `/conflicts/${conflictId}/resolve`,
        payload: { strategy: 'merged', content: '', expected_updated_at_ms: baseline },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(getNote(db, note.id)?.content, '');
    });

    it('400 VALIDATION on bad strategy', async () => {
      const { conflictId, baseline } = seedResolvable('R', 'L');
      const res = await app.inject({
        method: 'POST',
        url: `/conflicts/${conflictId}/resolve`,
        payload: { strategy: 'bogus', expected_updated_at_ms: baseline },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error_code, 'VALIDATION');
    });

    it('400 VALIDATION when expected_updated_at_ms missing / not a safe int', async () => {
      const { conflictId } = seedResolvable('R', 'L');
      for (const bad of [undefined, null, '100', -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
        const res = await app.inject({
          method: 'POST',
          url: `/conflicts/${conflictId}/resolve`,
          payload: { strategy: 'local', expected_updated_at_ms: bad },
        });
        assert.equal(res.statusCode, 400, `expected_updated_at_ms=${bad}`);
        assert.equal(res.json().error_code, 'VALIDATION');
      }
    });

    it('400 VALIDATION when merged has no string content', async () => {
      const { conflictId, baseline } = seedResolvable('R', 'L');
      const res = await app.inject({
        method: 'POST',
        url: `/conflicts/${conflictId}/resolve`,
        payload: { strategy: 'merged', expected_updated_at_ms: baseline },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error_code, 'VALIDATION');
    });

    it('404 CONFLICT_NOT_FOUND on unknown id (no emit)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/conflicts/nope/resolve',
        payload: { strategy: 'local', expected_updated_at_ms: 0 },
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error_code, 'CONFLICT_NOT_FOUND');
      assert.equal(captured.length, 0);
    });

    it('404 NOTE_NOT_FOUND when the conflict points at a missing note', async () => {
      const conflictId = recordConflict(sqlite, {
        entityType: 'note',
        entityId: 'ghost',
        losingSide: 'local',
        localPayload: { content: 'x' },
        remotePayload: { content: 'y' },
        localKey: { ms: 1, counter: 0, deviceId: 'dev-local' },
        remoteKey: { ms: 2, counter: 0, deviceId: 'dev-remote' },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/conflicts/${conflictId}/resolve`,
        payload: { strategy: 'local', expected_updated_at_ms: 0 },
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error_code, 'NOTE_NOT_FOUND');
    });

    it('409 VERSION_MISMATCH on stale baseline', async () => {
      const { note, conflictId, baseline } = seedResolvable('REMOTE', 'LOCAL');
      sqlite.prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(baseline + 5000, note.id);
      const res = await app.inject({
        method: 'POST',
        url: `/conflicts/${conflictId}/resolve`,
        payload: { strategy: 'local', expected_updated_at_ms: baseline },
      });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error_code, 'VERSION_MISMATCH');
    });

    it('422 UNSUPPORTED_ENTITY on a non-note conflict', async () => {
      const conflictId = recordConflict(sqlite, {
        entityType: 'folder',
        entityId: 'f1',
        losingSide: 'local',
        localPayload: { name: 'a' },
        remotePayload: { name: 'b' },
        localKey: { ms: 1, counter: 0, deviceId: 'dev-local' },
        remoteKey: { ms: 2, counter: 0, deviceId: 'dev-remote' },
      });
      const res = await app.inject({
        method: 'POST',
        url: `/conflicts/${conflictId}/resolve`,
        payload: { strategy: 'merged', content: 'x', expected_updated_at_ms: 0 },
      });
      assert.equal(res.statusCode, 422);
      assert.equal(res.json().error_code, 'UNSUPPORTED_ENTITY');
    });

    it('already-resolved → 200 {resolved:false}, no emit', async () => {
      const { conflictId, baseline } = seedResolvable('REMOTE', 'LOCAL');
      await app.inject({
        method: 'POST',
        url: `/conflicts/${conflictId}/resolve`,
        payload: { strategy: 'local', expected_updated_at_ms: baseline },
      });
      captured.length = 0;
      const second = await app.inject({
        method: 'POST',
        url: `/conflicts/${conflictId}/resolve`,
        payload: { strategy: 'local', expected_updated_at_ms: baseline },
      });
      assert.equal(second.statusCode, 200);
      assert.equal(second.json().data.resolved, false);
      assert.equal(second.json().data.reason, 'already_resolved');
      assert.equal(captured.length, 0, 'no event on idempotent no-op');
    });
  });
});
