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
import type { AppContext } from '../context.js';
import { EventsBus } from '../events/bus.js';
import { ReminderScheduler } from '../scheduler.js';
import { buildServer } from '../server.js';
import { __resetInflightSync } from './manual.js';
import type { RealSkybridgeClient, SkybridgeSession } from './session.js';

const TEST_SERVER_URL = 'http://127.0.0.1:18443';

describe('sync routes (P5-a Step 7)', () => {
  let app: ReturnType<typeof buildServer>;
  let ctx: AppContext;
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

    ctx = {
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
      skybridgeSession: null,
    };
    app = buildServer(ctx);
    await app.ready();
  });

  beforeEach(() => {
    // Reset config file + outbox + cursor between cases
    removeSkybridgeConfig(skybridgeConfigPath());
    sqlite.prepare('DELETE FROM sync_changes').run();
    sqlite.prepare('DELETE FROM sync_cursor').run();
    ctx.skybridgeSession = null;
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
    // P5-d Phase 10: daemon no longer reads toml on the sync path; both
    // missing-toml and missing-[auth] reduce to "no in-memory session"
    // → SKYBRIDGE_AUTH_REQUIRED. The pre-Phase-10 NotConfigured (400)
    // distinction lived only in the retired lazy-bootstrap code path.
    it('401 + SKYBRIDGE_AUTH_REQUIRED when no session installed (no toml)', async () => {
      const res = await app.inject({ method: 'POST', url: '/sync/run' });
      assert.equal(res.statusCode, 401);
      const body = res.json();
      assert.equal(body.success, false);
      assert.equal(body.error_code, 'SKYBRIDGE_AUTH_REQUIRED');
    });

    it('401 + SKYBRIDGE_AUTH_REQUIRED when toml exists but no session installed', async () => {
      writeSkybridgeConfig({ server: { url: TEST_SERVER_URL } }, skybridgeConfigPath());
      const res = await app.inject({ method: 'POST', url: '/sync/run' });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error_code, 'SKYBRIDGE_AUTH_REQUIRED');
    });

    // The pre-publish `SKYBRIDGE_NOT_INSTALLED` test that asserted the
    // dynamic import would fail on a clean checkout was removed once
    // `@orpheus-aviary/skybridge-client` became a hard runtime dep of
    // `@owl/daemon`. The error code path still exists for defense in
    // depth (an upstream consumer could npm-uninstall the dep), but
    // the supplied test environment can't reach it.
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

  // P5-d Phase 6 — POST /sync/login retired; GUI main is the sole toml
  // writer and seeds the daemon via /sync/session (or the dev double-env
  // gate). Hitting /sync/login now lands on Fastify's default 404.

  // ── POST /sync/session validation (P5-d Phase 6) ────────────

  describe('POST /sync/session', () => {
    function validBody() {
      return {
        token: 'tk-abc',
        user_id: 'u1',
        email: 'j@test',
        server_url: TEST_SERVER_URL,
        device: { id: 'dev-1', name: 'mac' },
        workspace: { id: 'ws-1' },
      };
    }

    async function expectMissing(field: string, mutator: (b: Record<string, unknown>) => void) {
      const body = validBody() as unknown as Record<string, unknown>;
      mutator(body);
      const res = await app.inject({ method: 'POST', url: '/sync/session', payload: body });
      assert.equal(res.statusCode, 400, `${field}: expected 400`);
      const json = res.json();
      assert.equal(json.error_code, 'USAGE_ERROR');
      assert.match(json.message, new RegExp(field.replace('.', '\\.')));
    }

    it('400 + USAGE_ERROR when token is missing', async () => {
      await expectMissing('token', (b) => {
        // biome-ignore lint/performance/noDelete: omitting the field is the assertion
        delete b.token;
      });
    });

    it('400 + USAGE_ERROR when device.id is missing', async () => {
      await expectMissing('device.id', (b) => {
        b.device = { name: 'mac' };
      });
    });

    it('400 + USAGE_ERROR when workspace.id is missing', async () => {
      await expectMissing('workspace.id', (b) => {
        b.workspace = {};
      });
    });
  });

  // ── POST /sync/logout-local (P5-d Phase 6) ──────────────────

  describe('POST /sync/logout-local', () => {
    it('clears ctx.skybridgeSession + skybridge identity rows in local_metadata', async () => {
      // Seed sqlite with the rows /sync/logout-local is supposed to delete,
      // and a parked sync_cursor row that MUST survive (v3 §3.6.2).
      sqlite
        .prepare("INSERT INTO local_metadata (key, value) VALUES ('skybridge_device_id', 'dev-X')")
        .run();
      sqlite
        .prepare(
          "INSERT INTO local_metadata (key, value) VALUES ('skybridge_workspace_id', 'ws-X')",
        )
        .run();
      sqlite
        .prepare("INSERT INTO local_metadata (key, value) VALUES ('skybridge_backfilled', '1')")
        .run();
      upsertSyncCursor(sqlite, TEST_SERVER_URL, { pulledSeq: 42, nowMs: 1 });

      const res = await app.inject({ method: 'POST', url: '/sync/logout-local' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().data, { cleared: true });

      const keys = (
        sqlite.prepare('SELECT key FROM local_metadata ORDER BY key').all() as { key: string }[]
      ).map((r) => r.key);
      assert.ok(!keys.includes('skybridge_device_id'), 'device id row removed');
      assert.ok(!keys.includes('skybridge_workspace_id'), 'workspace id row removed');
      assert.ok(!keys.includes('skybridge_backfilled'), 'backfill sentinel removed');

      const cursor = sqlite
        .prepare('SELECT pulled_seq FROM sync_cursor WHERE endpoint = ?')
        .get(TEST_SERVER_URL) as { pulled_seq: number } | undefined;
      assert.equal(cursor?.pulled_seq, 42, 'sync_cursor must survive logout-local');
    });

    it('is idempotent — a second call on already-clear state returns 200', async () => {
      const first = await app.inject({ method: 'POST', url: '/sync/logout-local' });
      assert.equal(first.statusCode, 200);
      const second = await app.inject({ method: 'POST', url: '/sync/logout-local' });
      assert.equal(second.statusCode, 200);
    });
  });

  // ── GET /sync/devices (P5-d Phase 10) ────────────────────────

  describe('GET /sync/devices', () => {
    // Build a minimal SkybridgeSession with a fake realClient whose only
    // method the route uses is `listDevices()`. Other RealSkybridgeClient
    // fields are widened via `as` because the route never touches them.
    const fakeDevice = {
      id: 'dev-A',
      name: 'tester (owl)',
      platform: 'darwin',
      appVersion: 'owl 0.4.2',
      clientVersion: '0.1.3',
      createdAt: 1700000000000,
      lastSeenAt: 1700000100000,
    };

    function injectFakeSession(
      listDevicesImpl: () => Promise<(typeof fakeDevice)[]> = async () => [fakeDevice],
    ): void {
      const realClient = {
        listDevices: listDevicesImpl,
      } as unknown as RealSkybridgeClient;
      ctx.skybridgeSession = {
        realClient,
        module: {} as SkybridgeSession['module'],
        config: { server: { url: TEST_SERVER_URL } } as SkybridgeSession['config'],
        workspaceId: 'ws-X',
        deviceId: 'dev-A',
        serverUrl: TEST_SERVER_URL,
      };
    }

    it('returns devices when session is installed', async () => {
      injectFakeSession();
      const res = await app.inject({ method: 'GET', url: '/sync/devices' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.success, true);
      assert.deepEqual(body.data, { devices: [fakeDevice] });
    });

    it('401 + SKYBRIDGE_AUTH_REQUIRED when no session installed', async () => {
      // ctx.skybridgeSession defaults to null via beforeEach
      const res = await app.inject({ method: 'GET', url: '/sync/devices' });
      assert.equal(res.statusCode, 401);
      const body = res.json();
      assert.equal(body.success, false);
      assert.equal(body.error_code, 'SKYBRIDGE_AUTH_REQUIRED');
    });

    it('translates SDK ApiError(401) → 401 + SKYBRIDGE_AUTH_REQUIRED + invalidates session', async () => {
      // Fake a skybridge-client ApiError shape: duck-typed by `name` +
      // `status` (manual.ts:140 isApiError).
      const apiError = Object.assign(new Error('token revoked'), {
        name: 'ApiError',
        status: 401,
      });
      injectFakeSession(async () => {
        throw apiError;
      });
      assert.ok(ctx.skybridgeSession, 'precondition: session installed');

      const res = await app.inject({ method: 'GET', url: '/sync/devices' });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error_code, 'SKYBRIDGE_AUTH_REQUIRED');
      assert.equal(
        ctx.skybridgeSession,
        null,
        'stale in-memory session must be invalidated on 401',
      );
    });
  });

  // ── POST /sync/revoke-device (P5-d Phase 17 / W9) ────────────

  describe('POST /sync/revoke-device', () => {
    function injectSession(revokeImpl: (id: string) => Promise<void> = async () => {}): {
      revoked: string[];
    } {
      const revoked: string[] = [];
      const realClient = {
        revokeDevice: async (id: string) => {
          revoked.push(id);
          return revokeImpl(id);
        },
      } as unknown as RealSkybridgeClient;
      ctx.skybridgeSession = {
        realClient,
        module: {} as SkybridgeSession['module'],
        config: { server: { url: TEST_SERVER_URL } } as SkybridgeSession['config'],
        workspaceId: 'ws-X',
        deviceId: 'dev-current',
        serverUrl: TEST_SERVER_URL,
      };
      return { revoked };
    }

    it('revokes the device and returns { revoked: true }', async () => {
      const tracker = injectSession();
      const res = await app.inject({
        method: 'POST',
        url: '/sync/revoke-device',
        payload: { device_id: 'dev-other' },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().data, { revoked: true });
      assert.deepEqual(tracker.revoked, ['dev-other']);
    });

    it('400 USAGE_ERROR when device_id is missing', async () => {
      injectSession();
      const res = await app.inject({ method: 'POST', url: '/sync/revoke-device', payload: {} });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error_code, 'USAGE_ERROR');
    });

    it('401 + SKYBRIDGE_AUTH_REQUIRED when no session installed', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/sync/revoke-device',
        payload: { device_id: 'dev-other' },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error_code, 'SKYBRIDGE_AUTH_REQUIRED');
    });

    it('translates SDK ApiError(401) → 401 + invalidates session', async () => {
      const apiError = Object.assign(new Error('token revoked'), { name: 'ApiError', status: 401 });
      injectSession(async () => {
        throw apiError;
      });
      const res = await app.inject({
        method: 'POST',
        url: '/sync/revoke-device',
        payload: { device_id: 'dev-other' },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json().error_code, 'SKYBRIDGE_AUTH_REQUIRED');
      assert.equal(ctx.skybridgeSession, null, 'stale session invalidated on 401');
    });
  });
});
