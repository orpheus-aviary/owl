/**
 * Phase A (A3b) — cloud self-login chain tests.
 *
 * Drives the real switch / install / background-handle machinery with a mock
 * SDK threaded through (so the bridge gets a mock client → no real network) and
 * a temp nest (OWL_NEST_DIR) for the profile dbs. Mirrors design §2.2 / §2.3 /
 * §5.1 / §9 #5-6.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type Logger,
  type OwlConfig,
  computeProfileId,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
  paths,
} from '@owl/core';
import { ConversationStore } from './ai/conversations.js';
import { PreviewStore } from './ai/preview-store.js';
import {
  AccountLockedError,
  SkybridgeServerTooOldError,
  cloudLogin,
  computeOwnerProfileId,
  refreshCloudSession,
} from './cloud-login.js';
import type { AppContext } from './context.js';
import { CredentialStore } from './credential-store.js';
import { EventsBus } from './events/bus.js';
import { ReminderScheduler } from './scheduler.js';
import { stopBackgroundHandles } from './sync/bridge-lifecycle.js';
import type { RealSkybridgeClient, SkybridgeClientModule } from './sync/session.js';

function silentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

// ─── Mock SDK ─────────────────────────────────────────────────────────

interface Spies {
  register: number;
  logout: number;
}

function mockClient(
  spies: Spies,
  opts: { registerId?: string; ensureWorkspace?: () => never } = {},
): RealSkybridgeClient {
  return {
    registerDevice: async () => {
      spies.register++;
      return { id: opts.registerId ?? 'dev-new', name: 'mock-device' };
    },
    ensureWorkspace: async () => {
      if (opts.ensureWorkspace) opts.ensureWorkspace();
      return { id: 'ws-1', slug: 'owl/default' };
    },
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

interface MockOpts {
  noServerId?: boolean;
  registerId?: string;
  expiresAt?: number;
  refreshThrows?: boolean;
  refreshToken?: string;
  ensureWorkspaceThrows?: boolean;
}

function mockSdk(spies: Spies, opts: MockOpts = {}): SkybridgeClientModule {
  return {
    CLIENT_VERSION: '0.1.4-test',
    login: async (serverUrl, email) => ({
      serverUrl,
      token: `tok-${email}`,
      user: { id: `u-${email}`, email },
      serverId: opts.noServerId ? undefined : 'srv-1',
      refreshToken: opts.refreshToken ?? 'ref-1',
      expiresAt: opts.expiresAt,
    }),
    refresh: async () => {
      if (opts.refreshThrows) throw new Error('REFRESH_INVALID');
      return { token: 'tok-refreshed', refreshToken: 'ref-2', expiresAt: opts.expiresAt };
    },
    getServerInfo: async () => ({ serverId: 'srv-1' }),
    createSkybridgeClient: () =>
      mockClient(spies, {
        registerId: opts.registerId,
        ensureWorkspace: opts.ensureWorkspaceThrows
          ? () => {
              throw new Error('ensureWorkspace failed');
            }
          : undefined,
      }),
  };
}

const loader = (sb: SkybridgeClientModule) => ({ loadClient: async () => sb });

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
    sync: { interval_min: 0 }, // no background sync timer in tests
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
    toolRegistry: {} as never,
    conversationStore: new ConversationStore(sqlite),
    previewStore: new PreviewStore(),
    eventsBus: new EventsBus(),
    skybridgeSession: null,
    sseBridge: null,
    syncScheduler: null,
    credentialStore: new CredentialStore(),
  } as AppContext;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'owl-cloud-login-'));
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
    ctx?.sqlite?.close();
  } catch {}
  // Reflect.deleteProperty (not the `delete` operator) to satisfy noDelete.
  if (prevNest === undefined) Reflect.deleteProperty(process.env, 'OWL_NEST_DIR');
  else process.env.OWL_NEST_DIR = prevNest;
  rmSync(tmp, { recursive: true, force: true });
});

describe('cloudLogin', () => {
  it('first login: binds Layer-1, caches creds, creates the profile db', async () => {
    ctx = makeCtx(cloudConfig());
    const spies: Spies = { register: 0, logout: 0 };
    const res = await cloudLogin(ctx, { email: 'a@test', password: 'pw' }, loader(mockSdk(spies)));

    const expected = computeProfileId('srv-1', 'u-a@test');
    assert.equal(res.profileId, expected);
    assert.equal(res.deviceId, 'dev-new');
    assert.equal(res.workspaceId, 'ws-1');
    assert.ok(ctx.credentialStore?.bound);
    assert.equal(ctx.credentialStore?.get()?.token, 'tok-a@test');
    assert.equal(ctx.credentialStore?.get()?.refreshToken, 'ref-1');
    assert.ok(ctx.skybridgeSession, 'Layer-1 session installed');
    assert.ok(existsSync(paths.profileDbPath(expected)), 'switched onto + created the profile db');
    assert.equal(spies.register, 1);
  });

  it('rejects a pre-0.1.4 server (no serverId) without binding', async () => {
    ctx = makeCtx(cloudConfig());
    const spies: Spies = { register: 0, logout: 0 };
    await assert.rejects(
      () =>
        cloudLogin(
          ctx,
          { email: 'a@test', password: 'pw' },
          loader(mockSdk(spies, { noServerId: true })),
        ),
      SkybridgeServerTooOldError,
    );
    assert.equal(ctx.credentialStore?.bound, false);
    assert.equal(spies.register, 0);
  });

  it('account_lock to another owner → AccountLockedError, no binding', async () => {
    ctx = makeCtx(cloudConfig({ account_lock: 'ffffffffffffffffffffffffffffffff' }));
    const spies: Spies = { register: 0, logout: 0 };
    await assert.rejects(
      () => cloudLogin(ctx, { email: 'a@test', password: 'pw' }, loader(mockSdk(spies))),
      AccountLockedError,
    );
    assert.equal(ctx.credentialStore?.bound, false);
  });

  it('account_lock to the owner → succeeds', async () => {
    const owner = computeProfileId('srv-1', 'u-a@test');
    ctx = makeCtx(cloudConfig({ account_lock: owner }));
    const spies: Spies = { register: 0, logout: 0 };
    const res = await cloudLogin(ctx, { email: 'a@test', password: 'pw' }, loader(mockSdk(spies)));
    assert.equal(res.profileId, owner);
  });

  it('return visit reuses the persisted device (no re-register)', async () => {
    // First login (fresh ctx) registers + persists device 'dev-new'.
    ctx = makeCtx(cloudConfig());
    await cloudLogin(
      ctx,
      { email: 'a@test', password: 'pw' },
      loader(mockSdk({ register: 0, logout: 0 })),
    );
    ctx.sqlite.close();

    // New (unbound) ctx onto the same nest → the profile db already exists.
    ctx = makeCtx(cloudConfig());
    const spies: Spies = { register: 0, logout: 0 };
    const res = await cloudLogin(
      ctx,
      { email: 'a@test', password: 'pw' },
      loader(mockSdk(spies, { registerId: 'dev-SHOULD-NOT-REGISTER' })),
    );
    assert.equal(res.deviceId, 'dev-new', 'reused the persisted device id');
    assert.equal(spies.register, 0, 'return visit must not register a new device');
  });

  it('multi-device: a second login to the same bound account rotates, no re-register', async () => {
    ctx = makeCtx(cloudConfig());
    const spies: Spies = { register: 0, logout: 0 };
    await cloudLogin(ctx, { email: 'a@test', password: 'pw' }, loader(mockSdk(spies)));
    assert.equal(spies.register, 1);

    // Second login on the SAME ctx (already bound to this profile).
    const res = await cloudLogin(
      ctx,
      { email: 'a@test', password: 'pw' },
      loader(mockSdk(spies, { registerId: 'dev-OTHER' })),
    );
    assert.equal(res.deviceId, 'dev-new', 'kept the bound device');
    assert.equal(spies.register, 1, 'multi-device login must not register again');
    assert.ok(ctx.skybridgeSession, 'session still bound');
  });

  it('compensation: a mid-chain failure tears down + best-effort remote logout', async () => {
    // Seed the profile db so login takes the return-visit branch (switch first),
    // then make ensureWorkspace throw AFTER the switch (switched=true → rollback).
    ctx = makeCtx(cloudConfig());
    await cloudLogin(
      ctx,
      { email: 'a@test', password: 'pw' },
      loader(mockSdk({ register: 0, logout: 0 })),
    );
    ctx.sqlite.close();

    ctx = makeCtx(cloudConfig());
    const spies: Spies = { register: 0, logout: 0 };
    await assert.rejects(() =>
      cloudLogin(
        ctx,
        { email: 'a@test', password: 'pw' },
        loader(mockSdk(spies, { ensureWorkspaceThrows: true })),
      ),
    );
    assert.equal(ctx.credentialStore?.bound, false, 'partial state dropped');
    assert.equal(ctx.skybridgeSession, null, 'session cleared');
    assert.equal(spies.logout, 1, 'best-effort remote logout fired');
  });
});

describe('refreshCloudSession', () => {
  it('rotates the token + rebinds the session', async () => {
    ctx = makeCtx(cloudConfig());
    await cloudLogin(
      ctx,
      { email: 'a@test', password: 'pw' },
      loader(mockSdk({ register: 0, logout: 0 })),
    );
    assert.equal(ctx.credentialStore?.get()?.token, 'tok-a@test');

    await refreshCloudSession(ctx, loader(mockSdk({ register: 0, logout: 0 })));
    assert.equal(ctx.credentialStore?.get()?.token, 'tok-refreshed');
    assert.equal(ctx.credentialStore?.get()?.refreshToken, 'ref-2');
    assert.ok(ctx.skybridgeSession, 'session rebound after refresh');
  });

  it('a hard refresh failure tears the cloud session down (re-login required)', async () => {
    ctx = makeCtx(cloudConfig());
    await cloudLogin(
      ctx,
      { email: 'a@test', password: 'pw' },
      loader(mockSdk({ register: 0, logout: 0 })),
    );
    assert.ok(ctx.credentialStore?.bound);

    await refreshCloudSession(
      ctx,
      loader(mockSdk({ register: 0, logout: 0 }, { refreshThrows: true })),
    );
    assert.equal(ctx.credentialStore?.bound, false);
    assert.equal(ctx.skybridgeSession, null);
  });
});

describe('computeOwnerProfileId (bootstrap helper)', () => {
  it('returns computeProfileId(serverId, userId) + best-effort revokes the token', async () => {
    const spies: Spies = { register: 0, logout: 0 };
    const profileId = await computeOwnerProfileId(
      { serverUrl: 'http://127.0.0.1:18443', email: 'a@test', password: 'pw' },
      loader(mockSdk(spies)),
    );
    assert.equal(profileId, computeProfileId('srv-1', 'u-a@test'));
    assert.equal(spies.logout, 1, 'one-shot login token revoked');
  });

  it('rejects a pre-0.1.4 server (no serverId)', async () => {
    const spies: Spies = { register: 0, logout: 0 };
    await assert.rejects(
      () =>
        computeOwnerProfileId(
          { serverUrl: 'http://127.0.0.1:18443', email: 'a@test', password: 'pw' },
          loader(mockSdk(spies, { noServerId: true })),
        ),
      SkybridgeServerTooOldError,
    );
  });
});
