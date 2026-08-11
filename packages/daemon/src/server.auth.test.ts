/**
 * Phase A (A2) — auth preHandler integration tests.
 *
 * Builds real servers (cloud + local) and drives them via inject. buildServer
 * does NOT run the A0 startup guard, so a cloud ctx can be assembled directly.
 * The session store is created by ensureSessionStore inside buildServer and
 * surfaced on ctx, so tests mint tokens through ctx.sessionStore.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type OwlConfig,
  type OwlDatabase,
  createConsoleLogger,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
} from '@owl/core';
import type Database from 'better-sqlite3';
import { ConversationStore } from './ai/conversations.js';
import { PreviewStore } from './ai/preview-store.js';
import { createBuiltinRegistry } from './ai/tools/index.js';
import { isLocalPublicPath, timingSafeEqualStr } from './auth.js';
import type { AppContext } from './context.js';
import { EventsBus } from './events/bus.js';
import { ReminderScheduler } from './scheduler.js';
import { buildServer } from './server.js';

function cloudConfig(): OwlConfig {
  return {
    ...DEFAULT_CONFIG,
    daemon: {
      ...DEFAULT_CONFIG.daemon,
      mode: 'cloud',
      server_url: 'http://127.0.0.1:18443',
      account_lock: 'off',
      public_url: 'http://127.0.0.1:47010',
    },
  };
}

// A6 — a local daemon must carry a local token (buildServer fail-closes without
// one); the local-gate tests present / withhold it explicitly.
const LOCAL_TOKEN = 'server-auth-local-token';

function buildCtx(config: OwlConfig): {
  ctx: AppContext;
  db: OwlDatabase;
  sqlite: Database.Database;
  scheduler: ReminderScheduler;
} {
  const { db, sqlite } = createDatabase({ dbPath: ':memory:' });
  ensureSpecialNotes(db);
  const logger = createConsoleLogger('auth-test', 'silent');
  const scheduler = new ReminderScheduler(db, sqlite, config, logger);
  const ctx: AppContext = {
    db,
    sqlite,
    config,
    logger,
    deviceId: ensureDeviceId(db),
    scheduler,
    toolRegistry: createBuiltinRegistry(),
    conversationStore: new ConversationStore(sqlite),
    previewStore: new PreviewStore(),
    eventsBus: new EventsBus(),
    skybridgeSession: null,
    localToken: config.daemon.mode === 'local' ? LOCAL_TOKEN : undefined,
  };
  return { ctx, db, sqlite, scheduler };
}

describe('auth preHandler — cloud mode', () => {
  it('allows the public allowlist without a bearer (GET /status)', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/status' });
    assert.equal(res.statusCode, 200);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('treats POST /auth/login as public (reaches the handler, not 401)', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    // The A4 route now exists; an empty body fails validation (400), proving
    // the preHandler let it through without a bearer rather than 401-ing it.
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error_code, 'USAGE_ERROR');
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('401 SESSION_REQUIRED when a protected route gets no bearer', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/notes' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error_code, 'SESSION_REQUIRED');
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('401 SESSION_INVALID for a bogus bearer', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error_code, 'SESSION_INVALID');
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('passes with a freshly-minted session bearer', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    const app = buildServer(ctx);
    await app.ready();
    assert.ok(ctx.sessionStore, 'ensureSessionStore should populate ctx.sessionStore');
    const { token } = ctx.sessionStore.mint('owner-profile');
    const res = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });
});

describe('auth preHandler — local mode (A6 local token gate)', () => {
  it('401 LOCAL_TOKEN_REQUIRED when a protected route gets no token', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(structuredClone(DEFAULT_CONFIG));
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/notes' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error_code, 'LOCAL_TOKEN_REQUIRED');
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('allows a protected route with the correct local token', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(structuredClone(DEFAULT_CONFIG));
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
    });
    assert.equal(res.statusCode, 200);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('401 on a wrong token', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(structuredClone(DEFAULT_CONFIG));
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: 'Bearer not-the-token' },
    });
    assert.equal(res.statusCode, 401);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('GET /status stays public (no token needed)', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(structuredClone(DEFAULT_CONFIG));
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/status' });
    assert.equal(res.statusCode, 200);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('an unregistered path is 401 without a token, 404 with it', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(structuredClone(DEFAULT_CONFIG));
    const app = buildServer(ctx);
    await app.ready();

    const noAuth = await app.inject({ method: 'POST', url: '/no-such-route', payload: {} });
    assert.equal(noAuth.statusCode, 401);
    assert.equal(noAuth.json().error_code, 'LOCAL_TOKEN_REQUIRED');

    const authed = await app.inject({
      method: 'POST',
      url: '/no-such-route',
      payload: {},
      headers: { authorization: `Bearer ${LOCAL_TOKEN}` },
    });
    assert.equal(authed.statusCode, 404);

    scheduler.stop();
    await app.close();
    sqlite.close();
  });
});

describe('GET /status shape (A6)', () => {
  it('local mode advertises mode + pid + local_auth_version', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(structuredClone(DEFAULT_CONFIG));
    const app = buildServer(ctx);
    await app.ready();
    const data = (await app.inject({ method: 'GET', url: '/status' })).json().data;
    assert.equal(data.mode, 'local');
    assert.equal(data.pid, process.pid);
    assert.equal(data.local_auth_version, 1);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('cloud mode advertises mode but omits pid + local_auth_version', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    const app = buildServer(ctx);
    await app.ready();
    const data = (await app.inject({ method: 'GET', url: '/status' })).json().data;
    assert.equal(data.mode, 'cloud');
    assert.equal(data.pid, undefined);
    assert.equal(data.local_auth_version, undefined);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  // 0.6.3 V3 — cloud sync health for an external monitor.
  it('cloud mode reports login_required with no session installed', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    const app = buildServer(ctx);
    await app.ready();
    const data = (await app.inject({ method: 'GET', url: '/status' })).json().data;
    assert.deepEqual(data.sync, {
      session_installed: false,
      state: 'login_required',
      last_success_at: null,
    });
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('cloud mode flips to session_ready once a session is installed', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    // biome-ignore lint/suspicious/noExplicitAny: stub session
    ctx.skybridgeSession = { serverUrl: 'http://x', workspaceId: 'w' } as any;
    const app = buildServer(ctx);
    await app.ready();
    const data = (await app.inject({ method: 'GET', url: '/status' })).json().data;
    assert.equal(data.sync.session_installed, true);
    assert.equal(data.sync.state, 'session_ready');
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  // /status is unauthenticated in both modes, so the field set is closed on
  // purpose. An allowlist (not a blocklist) — a future field carrying a token,
  // email, profile id, workspace or server url must fail this test loudly
  // rather than ship to an open endpoint.
  it('the public payload exposes exactly the documented fields', async () => {
    const cloud = buildCtx(cloudConfig());
    const cloudApp = buildServer(cloud.ctx);
    await cloudApp.ready();
    const cloudData = (await cloudApp.inject({ method: 'GET', url: '/status' })).json().data;
    assert.deepEqual(Object.keys(cloudData).sort(), ['mode', 'status', 'sync', 'uptime']);
    assert.deepEqual(Object.keys(cloudData.sync).sort(), [
      'last_success_at',
      'session_installed',
      'state',
    ]);
    cloud.scheduler.stop();
    await cloudApp.close();
    cloud.sqlite.close();

    const local = buildCtx(structuredClone(DEFAULT_CONFIG));
    const localApp = buildServer(local.ctx);
    await localApp.ready();
    const localData = (await localApp.inject({ method: 'GET', url: '/status' })).json().data;
    assert.deepEqual(Object.keys(localData).sort(), [
      'local_auth_version',
      'mode',
      'pid',
      'status',
      'uptime',
    ]);
    local.scheduler.stop();
    await localApp.close();
    local.sqlite.close();
  });
});

describe('local-auth helpers (A6)', () => {
  it('isLocalPublicPath allows only GET /status', () => {
    assert.equal(isLocalPublicPath('GET', '/status'), true);
    assert.equal(isLocalPublicPath('GET', '/status?x=1'), true);
    assert.equal(isLocalPublicPath('POST', '/status'), false);
    assert.equal(isLocalPublicPath('GET', '/notes'), false);
    assert.equal(isLocalPublicPath('GET', '/'), false);
  });

  it('timingSafeEqualStr matches equal, rejects mismatches, never throws on length', () => {
    assert.equal(timingSafeEqualStr('abc', 'abc'), true);
    assert.equal(timingSafeEqualStr('abc', 'abd'), false);
    // Different lengths (empty / super-long / unicode) must be false, not a 500.
    assert.equal(timingSafeEqualStr('', 'abc'), false);
    assert.equal(timingSafeEqualStr('abc', ''), false);
    assert.equal(timingSafeEqualStr('a'.repeat(100000), 'a'), false);
    assert.equal(timingSafeEqualStr('café', 'cafe'), false); // multibyte vs ascii
    assert.equal(timingSafeEqualStr('café', 'café'), true);
  });
});
