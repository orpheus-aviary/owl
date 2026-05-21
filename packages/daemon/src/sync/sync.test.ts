/**
 * P5-a Step 7 — daemon sync route unit tests.
 *
 * Exercises the bits of the sync surface that do NOT need a live
 * skybridge server: NotConfigured / AuthRequired / status snapshot /
 * USAGE_ERROR on login validation. Full pull/push round-trip lives in
 * `sync.e2e.ts` behind the SKYBRIDGE_E2E gate.
 *
 * Pins `OWL_NEST_DIR` to a per-suite tmp dir so the on-disk
 * `skybridge_config.toml` never touches the real ~/orpheus-aviary-nest/.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type OwlConfig,
  type OwlDatabase,
  createConsoleLogger,
  createDatabase,
  emitSyncChange,
  ensureDeviceId,
  ensureSpecialNotes,
  removeSkybridgeConfig,
  skybridgeConfigPath,
  upsertSyncCursor,
  writeSkybridgeConfig,
} from '@owl/core';
import type Database from 'better-sqlite3';
import { ConversationStore } from '../ai/conversations.js';
import { PreviewStore } from '../ai/preview-store.js';
import { createBuiltinRegistry } from '../ai/tools/index.js';
import { EventsBus } from '../events/bus.js';
import { ReminderScheduler } from '../scheduler.js';
import { buildServer } from '../server.js';
import { __resetInflightSync } from './manual.js';

const TEST_SERVER_URL = 'http://127.0.0.1:18443';

describe('sync routes (P5-a Step 7)', () => {
  let app: ReturnType<typeof buildServer>;
  let db: OwlDatabase;
  let sqlite: Database.Database;
  let scheduler: ReminderScheduler;
  let config: OwlConfig;
  let conversationStore: ConversationStore;
  let previewStore: PreviewStore;
  let nestDir: string;
  let priorEnv: string | undefined;

  before(async () => {
    nestDir = mkdtempSync(join(tmpdir(), 'sync-route-nest-'));
    priorEnv = process.env.OWL_NEST_DIR;
    process.env.OWL_NEST_DIR = nestDir;

    const created = createDatabase({ dbPath: ':memory:' });
    db = created.db;
    sqlite = created.sqlite;
    ensureSpecialNotes(db);
    const deviceId = ensureDeviceId(db);

    const logger = createConsoleLogger('sync-route-test', 'silent');
    config = structuredClone(DEFAULT_CONFIG);
    scheduler = new ReminderScheduler(db, sqlite, config, logger);
    conversationStore = new ConversationStore(sqlite);
    previewStore = new PreviewStore();

    app = buildServer({
      db,
      sqlite,
      config,
      logger,
      deviceId,
      scheduler,
      toolRegistry: createBuiltinRegistry(),
      conversationStore,
      previewStore,
      eventsBus: new EventsBus(),
    });
    await app.ready();
  });

  beforeEach(() => {
    // Reset config file + outbox + cursor between cases
    removeSkybridgeConfig(skybridgeConfigPath());
    sqlite.prepare('DELETE FROM sync_changes').run();
    sqlite.prepare('DELETE FROM sync_cursor').run();
    __resetInflightSync();
  });

  after(async () => {
    scheduler.stop();
    await app.close();
    sqlite.close();
    if (priorEnv === undefined) {
      // biome-ignore lint/performance/noDelete: assigning undefined stringifies it to "undefined" in process.env; delete is the only way to truly unset
      delete process.env.OWL_NEST_DIR;
    } else {
      process.env.OWL_NEST_DIR = priorEnv;
    }
    rmSync(nestDir, { recursive: true, force: true });
  });

  // ── POST /sync/run ──────────────────────────────────────────

  describe('POST /sync/run', () => {
    it('400 + SKYBRIDGE_NOT_CONFIGURED when no toml exists', async () => {
      const res = await app.inject({ method: 'POST', url: '/sync/run' });
      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.equal(body.success, false);
      assert.equal(body.error_code, 'SKYBRIDGE_NOT_CONFIGURED');
    });

    it('401 + SKYBRIDGE_AUTH_REQUIRED when [auth] is absent', async () => {
      writeSkybridgeConfig({ server: { url: TEST_SERVER_URL } }, skybridgeConfigPath());
      const res = await app.inject({ method: 'POST', url: '/sync/run' });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error_code, 'SKYBRIDGE_AUTH_REQUIRED');
    });

    it('500 + SKYBRIDGE_NOT_INSTALLED when toml is valid but @skybridge/client is absent', async () => {
      // Auth is present, so we get past the config guards; the next
      // step (dynamic import of `@skybridge/client`) fails on a clean
      // checkout — exactly the install-guard the production daemon
      // should surface.
      writeSkybridgeConfig(
        {
          server: { url: TEST_SERVER_URL },
          auth: { user_id: 'u', token: 't', email: 'e' },
        },
        skybridgeConfigPath(),
      );
      const res = await app.inject({ method: 'POST', url: '/sync/run' });
      assert.equal(res.statusCode, 500);
      assert.equal(res.json().error_code, 'SKYBRIDGE_NOT_INSTALLED');
    });
  });

  // ── GET /sync/status ────────────────────────────────────────

  describe('GET /sync/status', () => {
    it('reports configured=false / 0 pending when no toml + clean outbox', async () => {
      const res = await app.inject({ method: 'GET', url: '/sync/status' });
      assert.equal(res.statusCode, 200);
      const status = res.json().data;
      assert.equal(status.configured, false);
      assert.equal(status.authenticated, false);
      assert.equal(status.server_url, null);
      assert.equal(status.device_id, null);
      assert.equal(status.workspace_id, null);
      assert.equal(status.pending_count, 0);
      assert.equal(status.pulled_seq, 0);
      assert.equal(status.pushed_seq, 0);
      assert.equal(status.last_sync_at, null);
    });

    it('counts only outbox rows where synced_at IS NULL', async () => {
      // 2 pending + 1 already-synced row
      emitSyncChange(sqlite, {
        entityType: 'note',
        entityId: 'n-1',
        op: 'create',
        payload: { content: 'a', updated_at_ms: 1_000 },
      });
      emitSyncChange(sqlite, {
        entityType: 'note',
        entityId: 'n-2',
        op: 'create',
        payload: { content: 'b', updated_at_ms: 1_001 },
      });
      const syncedCid = emitSyncChange(sqlite, {
        entityType: 'note',
        entityId: 'n-3',
        op: 'create',
        payload: { content: 'c', updated_at_ms: 1_002 },
      });
      sqlite
        .prepare(
          'UPDATE sync_changes SET server_seq = 99, synced_at = 5000 WHERE client_change_id = ?',
        )
        .run(syncedCid);

      const res = await app.inject({ method: 'GET', url: '/sync/status' });
      assert.equal(res.json().data.pending_count, 2);
    });

    it('returns cursor pulled_seq / pushed_seq / last_sync_at for the configured server_url', async () => {
      writeSkybridgeConfig(
        {
          server: { url: TEST_SERVER_URL },
          auth: { user_id: 'u', token: 't', email: 'e' },
          device: {
            id: 'dev_1',
            name: 'mb',
            app_version: 'owl 0.5.0-dev',
            client_version: '0.1.0',
          },
          workspace: { id: 'ws_1', slug: 'owl/default' },
        },
        skybridgeConfigPath(),
      );
      upsertSyncCursor(sqlite, TEST_SERVER_URL, { pulledSeq: 17, pushedSeq: 4, nowMs: 12345 });

      const res = await app.inject({ method: 'GET', url: '/sync/status' });
      const data = res.json().data;
      assert.equal(data.configured, true);
      assert.equal(data.authenticated, true);
      assert.equal(data.server_url, TEST_SERVER_URL);
      assert.equal(data.device_id, 'dev_1');
      assert.equal(data.workspace_id, 'ws_1');
      assert.equal(data.pulled_seq, 17);
      assert.equal(data.pushed_seq, 4);
      assert.equal(data.last_sync_at, 12345);
    });

    it('ignores cursor rows belonging to other servers', async () => {
      writeSkybridgeConfig(
        {
          server: { url: TEST_SERVER_URL },
          auth: { user_id: 'u', token: 't', email: 'e' },
        },
        skybridgeConfigPath(),
      );
      upsertSyncCursor(sqlite, 'http://other:9999', { pulledSeq: 50, nowMs: 1 });
      const res = await app.inject({ method: 'GET', url: '/sync/status' });
      assert.equal(res.json().data.pulled_seq, 0, 'other-server cursor must not leak');
    });
  });

  // ── POST /sync/login validation ─────────────────────────────

  describe('POST /sync/login', () => {
    it('400 + USAGE_ERROR when email or password missing', async () => {
      const noEmail = await app.inject({
        method: 'POST',
        url: '/sync/login',
        payload: { password: 'pw' },
      });
      assert.equal(noEmail.statusCode, 400);
      assert.equal(noEmail.json().error_code, 'USAGE_ERROR');

      const noPw = await app.inject({
        method: 'POST',
        url: '/sync/login',
        payload: { email: 'a@b' },
      });
      assert.equal(noPw.statusCode, 400);
      assert.equal(noPw.json().error_code, 'USAGE_ERROR');
    });

    it('400 + SKYBRIDGE_SERVER_URL_MISSING when no config + no server_url body field', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/login',
        payload: { email: 'a@b', password: 'pw' },
      });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error_code, 'SKYBRIDGE_SERVER_URL_MISSING');
    });

    it('500 + SKYBRIDGE_NOT_INSTALLED when server_url provided but skybridge package absent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/login',
        payload: {
          email: 'jay@local',
          password: 'longenoughpw',
          server_url: TEST_SERVER_URL,
        },
      });
      assert.equal(res.statusCode, 500);
      assert.equal(res.json().error_code, 'SKYBRIDGE_NOT_INSTALLED');
    });
  });
});
