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
  type OwlDatabase,
  createConsoleLogger,
  createDatabase,
  ensureDeviceId,
  recordConflict,
} from '@owl/core';
import type Database from 'better-sqlite3';
import { ConversationStore } from '../ai/conversations.js';
import { PreviewStore } from '../ai/preview-store.js';
import { createBuiltinRegistry } from '../ai/tools/index.js';
import { EventsBus } from '../events/bus.js';
import type { OwlEvent } from '../events/types.js';
import { ReminderScheduler } from '../scheduler.js';
import { buildServer } from '../server.js';

describe('conflicts routes (P5-c Step 13)', () => {
  let app: ReturnType<typeof buildServer>;
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

    app = buildServer({
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
      localUpdatedAtMs: detectedAt - 100,
      remoteUpdatedAtMs: detectedAt,
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
});
