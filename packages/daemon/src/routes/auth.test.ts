/**
 * Phase A (A4) — /auth/* route integration tests.
 *
 * Drives a real cloud-mode server via inject, with the skybridge SDK mocked
 * through ctx.skybridgeLoader so the full cloudLogin chain (switch / install /
 * background handles) runs without a network. A temp nest (OWL_NEST_DIR) holds
 * the profile dbs. Mirrors cloud-login.test.ts's harness + buildServer.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type Logger,
  type OwlConfig,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
  paths,
} from '@owl/core';
import { ConversationStore } from '../ai/conversations.js';
import { PreviewStore } from '../ai/preview-store.js';
import { createBuiltinRegistry } from '../ai/tools/index.js';
import type { AppContext } from '../context.js';
import { CredentialStore } from '../credential-store.js';
import { EventsBus } from '../events/bus.js';
import { ReminderScheduler } from '../scheduler.js';
import { buildServer } from '../server.js';
import { stopBackgroundHandles } from '../sync/bridge-lifecycle.js';
import type { RealSkybridgeClient, SkybridgeClientModule } from '../sync/session.js';

function silentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

// ─── Mock SDK ─────────────────────────────────────────────────────────

interface Spies {
  logout: number;
}

function mockClient(spies: Spies): RealSkybridgeClient {
  return {
    registerDevice: async () => ({ id: 'dev-new', name: 'mock-device' }),
    ensureWorkspace: async () => ({ id: 'ws-1', slug: 'owl/default' }),
    pushChanges: async () => ({ accepted: [], duplicates: [], latestSeq: 0, serverTime: 0 }),
    pullChanges: async () => ({ changes: [], hasMore: false, latestSeq: 0, serverTime: 0 }),
    subscribeEvents: () => () => {},
    listDevices: async () => [],
    revokeDevice: async () => {},
    logout: async () => {
      spies.logout++;
    },
  } as RealSkybridgeClient;
}

/** Mock module whose login succeeds, or throws an ApiError-shaped 401. */
function mockSdk(spies: Spies, opts: { loginThrows?: boolean } = {}): SkybridgeClientModule {
  return {
    CLIENT_VERSION: '0.1.4-test',
    login: async (serverUrl, email) => {
      if (opts.loginThrows) {
        const err = new Error('invalid credentials') as Error & { name: string; status: number };
        err.name = 'ApiError';
        err.status = 401;
        throw err;
      }
      return {
        serverUrl,
        token: `tok-${email}`,
        user: { id: `u-${email}`, email },
        serverId: 'srv-1',
        refreshToken: 'ref-1',
        expiresAt: undefined,
      };
    },
    refresh: async () => ({ token: 'tok-refreshed', refreshToken: 'ref-2', expiresAt: undefined }),
    getServerInfo: async () => ({ serverId: 'srv-1' }),
    createSkybridgeClient: () => mockClient(spies),
  };
}

// ─── Harness ──────────────────────────────────────────────────────────

let tmp: string;
let prevNest: string | undefined;
let ctx: AppContext;

function cloudConfig(overrides: Partial<OwlConfig['daemon']> = {}): OwlConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    daemon: {
      ...DEFAULT_CONFIG.daemon,
      mode: 'cloud',
      server_url: 'http://127.0.0.1:18443',
      account_lock: 'off',
      public_url: 'http://127.0.0.1:47010',
      ...overrides,
    },
    sync: { interval_min: 0 },
  };
}

function makeCtx(config: OwlConfig, sdk: SkybridgeClientModule): AppContext {
  mkdirSync(paths.owlDir(), { recursive: true });
  const { db, sqlite } = createDatabase({ dbPath: paths.localProfileDbPath() });
  const deviceId = ensureDeviceId(db);
  ensureSpecialNotes(db);
  const logger = silentLogger();
  return {
    db,
    sqlite,
    config,
    logger,
    deviceId,
    scheduler: new ReminderScheduler(db, sqlite, config, logger),
    toolRegistry: createBuiltinRegistry(),
    conversationStore: new ConversationStore(sqlite),
    previewStore: new PreviewStore(),
    eventsBus: new EventsBus(),
    skybridgeSession: null,
    sseBridge: null,
    syncScheduler: null,
    credentialStore: new CredentialStore(),
    skybridgeLoader: async () => sdk,
  } as AppContext;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'owl-auth-route-'));
  prevNest = process.env.OWL_NEST_DIR;
  process.env.OWL_NEST_DIR = tmp;
});

afterEach(() => {
  try {
    ctx?.scheduler?.stop();
  } catch {}
  try {
    stopBackgroundHandles(ctx);
  } catch {}
  try {
    ctx?.sessionStore?.stopSweep();
  } catch {}
  try {
    ctx?.refreshTimer && clearTimeout(ctx.refreshTimer);
  } catch {}
  try {
    ctx?.sqlite?.close();
  } catch {}
  if (prevNest === undefined) Reflect.deleteProperty(process.env, 'OWL_NEST_DIR');
  else process.env.OWL_NEST_DIR = prevNest;
  rmSync(tmp, { recursive: true, force: true });
});

describe('POST /auth/login', () => {
  it('logs in, mints a Layer-2 session, and the bearer then unlocks CRUD', async () => {
    ctx = makeCtx(cloudConfig(), mockSdk({ logout: 0 }));
    const app = buildServer(ctx);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'a@test', password: 'pw' },
    });
    assert.equal(res.statusCode, 200);
    const data = res.json().data as {
      session_token: string;
      expires_at: number;
      identity: { email: string; device_id: string; workspace_id: string };
    };
    assert.ok(data.session_token);
    assert.equal(data.identity.email, 'a@test');
    assert.equal(data.identity.device_id, 'dev-new');

    // No bearer → 401; with the minted bearer → 200.
    assert.equal((await app.inject({ method: 'GET', url: '/notes' })).statusCode, 401);
    const crud = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: `Bearer ${data.session_token}` },
    });
    assert.equal(crud.statusCode, 200);

    await app.close();
  });

  it('400 USAGE_ERROR on a missing field', async () => {
    ctx = makeCtx(cloudConfig(), mockSdk({ logout: 0 }));
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'a@test' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error_code, 'USAGE_ERROR');
    await app.close();
  });

  it('401 INVALID_CREDENTIALS on a bad password, then throttles after the limit', async () => {
    ctx = makeCtx(cloudConfig(), mockSdk({ logout: 0 }, { loginThrows: true }));
    const app = buildServer(ctx);
    await app.ready();

    // Default maxPerEmail is 5: five 401s, then the sixth is throttled (429)
    // without even reaching cloudLogin.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'a@test', password: 'wrong' },
      });
      assert.equal(res.statusCode, 401, `attempt ${i}`);
      assert.equal(res.json().error_code, 'INVALID_CREDENTIALS');
    }
    const throttled = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'a@test', password: 'wrong' },
    });
    assert.equal(throttled.statusCode, 429);
    assert.equal(throttled.json().error_code, 'LOGIN_THROTTLED');
    assert.ok(throttled.headers['retry-after']);
    await app.close();
  });

  it('404 on a local daemon (no Layer-2 concept)', async () => {
    ctx = makeCtx(structuredClone(DEFAULT_CONFIG), mockSdk({ logout: 0 }));
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'a@test', password: 'pw' },
    });
    assert.equal(res.statusCode, 404);
    await app.close();
  });
});

describe('POST /auth/logout', () => {
  it('single logout revokes the session but leaves Layer-1 bound', async () => {
    ctx = makeCtx(cloudConfig(), mockSdk({ logout: 0 }));
    const app = buildServer(ctx);
    await app.ready();
    const token = await login(app);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.logged_out, true);
    // Token no longer works; Layer-1 binding is intact.
    assert.equal((await whoami(app, token)).statusCode, 401);
    assert.ok(ctx.credentialStore?.bound, 'Layer-1 stays bound on single logout');
    await app.close();
  });

  it('logout {all} remote-revokes the skybridge token + full teardown', async () => {
    const spies: Spies = { logout: 0 };
    ctx = makeCtx(cloudConfig(), mockSdk(spies));
    const app = buildServer(ctx);
    await app.ready();
    const token = await login(app);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${token}` },
      payload: { all: true },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.logged_out_all, true);
    assert.equal(spies.logout, 1, 'remote token revoked');
    assert.equal(ctx.credentialStore?.bound, false, 'Layer-1 torn down');
    assert.equal(ctx.skybridgeSession, null);
    await app.close();
  });
});

describe('GET /auth/session', () => {
  it('returns whoami identity for a live session', async () => {
    ctx = makeCtx(cloudConfig(), mockSdk({ logout: 0 }));
    const app = buildServer(ctx);
    await app.ready();
    const token = await login(app);

    const res = await whoami(app, token);
    assert.equal(res.statusCode, 200);
    const data = res.json().data as { identity: { email: string }; expires_at: number };
    assert.equal(data.identity.email, 'a@test');
    assert.ok(data.expires_at > 0);
    await app.close();
  });
});

describe('cloud disables GUI-main plumbing (§4.3 ③)', () => {
  for (const path of ['/sync/session', '/sync/switch', '/sync/logout-local']) {
    it(`404s ${path} even with a valid bearer`, async () => {
      ctx = makeCtx(cloudConfig(), mockSdk({ logout: 0 }));
      const app = buildServer(ctx);
      await app.ready();
      const { token } = ctx.sessionStore?.mint('p') ?? { token: '' };
      const res = await app.inject({
        method: 'POST',
        url: path,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error_code, 'NOT_FOUND');
      await app.close();
    });
  }
});

// ─── helpers ──────────────────────────────────────────────────────────

async function login(app: ReturnType<typeof buildServer>): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'a@test', password: 'pw' },
  });
  assert.equal(res.statusCode, 200, 'login should succeed');
  return res.json().data.session_token as string;
}

function whoami(app: ReturnType<typeof buildServer>, token: string) {
  return app.inject({
    method: 'GET',
    url: '/auth/session',
    headers: { authorization: `Bearer ${token}` },
  });
}
