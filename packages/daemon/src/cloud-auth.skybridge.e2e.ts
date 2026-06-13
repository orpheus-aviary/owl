/**
 * Phase A (A4) — cloud auth end-to-end against a real in-process skybridge.
 *
 * Drives the REAL cloud self-login chain (no mock SDK — `cloudLogin` uses the
 * live `@orpheus-aviary/skybridge-client` against an in-process skybridge
 * server) through `buildServer` + inject:
 *   - POST /auth/login with a real password → Layer-2 token → authenticated CRUD
 *   - no / bad bearer → 401
 *   - account_lock rejects a non-owner account
 *   - "restart" (drop the ctx, rebuild on the same nest) → re-login reuses the
 *     persisted device (RAM-only credentials, §7.7)
 *   - cloud disables the GUI-main plumbing endpoints (404)
 *
 * Gating mirrors sync.e2e.ts: filename `*.e2e.ts` keeps it out of the default
 * `just test-daemon` glob (only `just test-skybridge-e2e` runs it), and the
 * `{ skip: !SKYBRIDGE_E2E }` guard is belt-and-suspenders. Run standalone on
 * Node ABI (`just ensure-node-abi`, GUI closed).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type Logger,
  type OwlConfig,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
  paths,
} from '@owl/core';
import { ConversationStore } from './ai/conversations.js';
import { PreviewStore } from './ai/preview-store.js';
import { createBuiltinRegistry } from './ai/tools/index.js';
import { computeOwnerProfileId, teardownCloudSession } from './cloud-login.js';
import type { AppContext } from './context.js';
import { CredentialStore } from './credential-store.js';
import { EventsBus } from './events/bus.js';
import { ReminderScheduler } from './scheduler.js';
import { buildServer } from './server.js';

const gate = process.env.SKYBRIDGE_E2E === '1';

// Structural shape of @orpheus-aviary/skybridge-server (not imported as a type —
// the package may be absent on a clean checkout). Mirrors sync.e2e.ts.
interface SkybridgeServerModule {
  defaultConfig(dir: string): {
    storage: { dbPath: string };
    logging: { level: string; file: string | null };
  };
  openDb(opts: { path: string; requireMigrationsApplied: boolean }): { close(): void };
  applyMigrations(db: unknown): void;
  buildApp(opts: { config: unknown; logger: false }): Promise<{
    app: {
      listen(opts: { host: string; port: number }): Promise<void>;
      close(): Promise<void>;
      server: { address(): { port: number } | string | null };
    };
    db: unknown;
  }>;
  createUser(db: unknown, input: { email: string; password: string }): Promise<unknown>;
}

const OWNER = { email: 'owner@x.test', password: 'longenoughpw' };
const INTRUDER = { email: 'intruder@x.test', password: 'longenoughpw' };

function silentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

function cloudConfig(serverUrl: string, accountLock: string): OwlConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    daemon: {
      ...DEFAULT_CONFIG.daemon,
      mode: 'cloud',
      server_url: serverUrl,
      account_lock: accountLock,
      public_url: 'http://127.0.0.1:47010',
    },
    sync: { interval_min: 0 }, // no background sync timer
  };
}

function makeCtx(config: OwlConfig): AppContext {
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
  } as AppContext;
}

async function tearDown(
  ctx: AppContext | null,
  app: { close(): Promise<void> } | null,
): Promise<void> {
  if (ctx) {
    try {
      ctx.scheduler?.stop();
    } catch {}
    teardownCloudSession(ctx);
    ctx.sessionStore?.stopSweep();
  }
  if (app) await app.close();
  try {
    ctx?.sqlite?.close();
  } catch {}
}

describe('cloud auth e2e (in-process skybridge)', { skip: !gate }, () => {
  let serverUrl: string;
  let serverCleanup: () => Promise<void>;
  let ownerProfileId: string;
  let nest: string;
  let prevNest: string | undefined;
  let ctx: AppContext | null = null;
  let app: ReturnType<typeof buildServer> | null = null;

  before(async () => {
    const spec = '@orpheus-aviary/skybridge-server';
    const sb = (await import(spec)) as SkybridgeServerModule;
    const tmp = mkdtempSync(join(tmpdir(), 'cloud-auth-e2e-srv-'));
    const config = sb.defaultConfig(tmp);
    config.logging.file = null;
    config.logging.level = 'error';
    const initDb = sb.openDb({ path: config.storage.dbPath, requireMigrationsApplied: false });
    sb.applyMigrations(initDb);
    initDb.close();
    const built = await sb.buildApp({ config, logger: false });
    await built.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = built.app.server.address();
    if (!addr || typeof addr !== 'object') throw new Error('no port from skybridge listen');
    serverUrl = `http://127.0.0.1:${addr.port}`;
    serverCleanup = async () => {
      await built.app.close();
      rmSync(tmp, { recursive: true, force: true });
    };
    await sb.createUser(built.db, OWNER);
    await sb.createUser(built.db, INTRUDER);
    // Compute the owner profileId the way `owl-server compute-owner` does — a
    // one-shot login against the live server (real SDK, no mock).
    ownerProfileId = await computeOwnerProfileId({ serverUrl, ...OWNER });
  });

  after(async () => {
    if (serverCleanup) await serverCleanup();
  });

  beforeEach(() => {
    nest = mkdtempSync(join(tmpdir(), 'cloud-auth-e2e-nest-'));
    prevNest = process.env.OWL_NEST_DIR;
    process.env.OWL_NEST_DIR = nest;
    ctx = null;
    app = null;
  });

  afterEach(async () => {
    await tearDown(ctx, app);
    if (prevNest === undefined) Reflect.deleteProperty(process.env, 'OWL_NEST_DIR');
    else process.env.OWL_NEST_DIR = prevNest;
    rmSync(nest, { recursive: true, force: true });
  });

  it('real login → Layer-2 token → authenticated CRUD; no/bad bearer → 401', async () => {
    ctx = makeCtx(cloudConfig(serverUrl, ownerProfileId));
    app = buildServer(ctx);
    await app.ready();

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: OWNER });
    assert.equal(login.statusCode, 200, login.body);
    const { session_token, identity } = login.json().data;
    assert.equal(identity.profile_id, ownerProfileId);
    assert.equal(identity.email, OWNER.email);
    assert.ok(identity.device_id);

    // No bearer → 401; valid bearer → 200.
    assert.equal((await app.inject({ method: 'GET', url: '/notes' })).statusCode, 401);
    const crud = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: `Bearer ${session_token}` },
    });
    assert.equal(crud.statusCode, 200);

    // whoami reflects the real identity.
    const who = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { authorization: `Bearer ${session_token}` },
    });
    assert.equal(who.statusCode, 200);
    assert.equal(who.json().data.identity.profile_id, ownerProfileId);

    // status reads the cloud (RAM) source, not toml.
    const status = await app.inject({
      method: 'GET',
      url: '/sync/status',
      headers: { authorization: `Bearer ${session_token}` },
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().data.configured, true);
    assert.equal(status.json().data.server_url, serverUrl);
  });

  it('account_lock rejects a non-owner account (403)', async () => {
    ctx = makeCtx(cloudConfig(serverUrl, ownerProfileId));
    app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: INTRUDER });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error_code, 'ACCOUNT_LOCKED');
    assert.equal(ctx.credentialStore?.bound, false);
  });

  it('restart drops RAM creds; re-login reuses the persisted device', async () => {
    // First login registers + persists the device into the profile db.
    const ctx1 = makeCtx(cloudConfig(serverUrl, ownerProfileId));
    const app1 = buildServer(ctx1);
    await app1.ready();
    const r1 = await app1.inject({ method: 'POST', url: '/auth/login', payload: OWNER });
    assert.equal(r1.statusCode, 200);
    const device1 = r1.json().data.identity.device_id;
    await tearDown(ctx1, app1); // simulate a daemon restart (creds are RAM-only)

    // Rebuild on the SAME nest → the profile db already exists → return visit.
    ctx = makeCtx(cloudConfig(serverUrl, ownerProfileId));
    app = buildServer(ctx);
    await app.ready();
    const r2 = await app.inject({ method: 'POST', url: '/auth/login', payload: OWNER });
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.json().data.identity.device_id, device1, 'reused the persisted device');
  });

  it('cloud disables the GUI-main plumbing endpoints (404)', async () => {
    ctx = makeCtx(cloudConfig(serverUrl, ownerProfileId));
    const built = buildServer(ctx);
    app = built;
    await built.ready();
    const login = await built.inject({ method: 'POST', url: '/auth/login', payload: OWNER });
    const token = login.json().data.session_token;
    for (const path of ['/sync/session', '/sync/switch', '/sync/logout-local']) {
      const res = await built.inject({
        method: 'POST',
        url: path,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      assert.equal(res.statusCode, 404, `${path} should 404 in cloud`);
    }
  });
});
