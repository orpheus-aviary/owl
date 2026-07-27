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
import { SessionStore } from './auth.js';
import {
  AccountBusyError,
  AccountLockedError,
  SkybridgeServerTooOldError,
  clearRefreshTimer,
  cloudLogin,
  computeOwnerProfileId,
  computeRefreshDelayMs,
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
  /** Throw a server verdict that the refresh token is dead (ApiError-shaped). */
  refreshThrows?: boolean;
  /** Throw a transport-level failure instead (NetworkError-shaped). */
  refreshThrowsTransient?: boolean;
  refreshToken?: string;
  ensureWorkspaceThrows?: boolean;
}

/**
 * The daemon duck-types skybridge SDK errors on `.name` (it never imports the
 * module statically), so the mocks must carry the same tags the real client
 * sets — otherwise every failure would look transient.
 */
function apiError(code: string, status: number): Error {
  return Object.assign(new Error(code), { name: 'ApiError', code, status });
}

function networkError(message: string): Error {
  return Object.assign(new Error(message), { name: 'NetworkError' });
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
      if (opts.refreshThrows) throw apiError('REFRESH_INVALID', 401);
      if (opts.refreshThrowsTransient) throw networkError('connect ECONNREFUSED');
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

  it('off mode: a different account cannot preempt one with live sessions (§5.3)', async () => {
    ctx = makeCtx(cloudConfig());
    ctx.sessionStore = new SessionStore(60_000);
    await cloudLogin(
      ctx,
      { email: 'a@test', password: 'pw' },
      loader(mockSdk({ register: 0, logout: 0 })),
    );
    ctx.sessionStore.mint('any-profile'); // a live client of account A

    await assert.rejects(
      () =>
        cloudLogin(
          ctx,
          { email: 'b@test', password: 'pw' },
          loader(mockSdk({ register: 0, logout: 0 })),
        ),
      AccountBusyError,
    );
    assert.equal(ctx.credentialStore?.get()?.email, 'a@test', 'A is still bound');
  });

  it('off mode: a different account binds once the incumbent has no live sessions', async () => {
    ctx = makeCtx(cloudConfig());
    ctx.sessionStore = new SessionStore(60_000);
    await cloudLogin(
      ctx,
      { email: 'a@test', password: 'pw' },
      loader(mockSdk({ register: 0, logout: 0 })),
    );
    // No Layer-2 sessions live → A is free → B may take over.
    const res = await cloudLogin(
      ctx,
      { email: 'b@test', password: 'pw' },
      loader(mockSdk({ register: 0, logout: 0 })),
    );
    assert.equal(res.email, 'b@test');
    assert.equal(ctx.credentialStore?.get()?.email, 'b@test', 'B is now bound');
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

    const result = await refreshCloudSession(ctx, loader(mockSdk({ register: 0, logout: 0 })));
    assert.equal(result.outcome, 'refreshed');
    assert.equal(ctx.credentialStore?.get()?.token, 'tok-refreshed');
    assert.equal(ctx.credentialStore?.get()?.refreshToken, 'ref-2');
    assert.ok(ctx.skybridgeSession, 'session rebound after refresh');
  });

  it('a server verdict on the refresh token tears the cloud session down', async () => {
    ctx = makeCtx(cloudConfig());
    await cloudLogin(
      ctx,
      { email: 'a@test', password: 'pw' },
      loader(mockSdk({ register: 0, logout: 0 })),
    );
    assert.ok(ctx.credentialStore?.bound);

    const result = await refreshCloudSession(
      ctx,
      loader(mockSdk({ register: 0, logout: 0 }, { refreshThrows: true })),
    );
    assert.equal(result.outcome, 'logged_out');
    assert.equal(ctx.credentialStore?.bound, false);
    assert.equal(ctx.skybridgeSession, null);
    assert.equal(ctx.refreshTimer ?? null, null, 'no retry scheduled for a dead refresh token');
  });

  // Problem A / Phase 2B: the pre-fix code tore the session down on ANY refresh
  // error, so a single network blip logged the cloud daemon out for good (and
  // revoked every Layer-2 browser session with it).
  it('a transient refresh failure keeps credentials + schedules a retry', async () => {
    ctx = makeCtx(cloudConfig());
    await cloudLogin(
      ctx,
      { email: 'a@test', password: 'pw' },
      loader(mockSdk({ register: 0, logout: 0 })),
    );
    const sessionsBefore = ctx.sessionStore?.liveCount() ?? 0;

    const result = await refreshCloudSession(
      ctx,
      loader(mockSdk({ register: 0, logout: 0 }, { refreshThrowsTransient: true })),
    );
    assert.equal(result.outcome, 'transient_failure');
    assert.ok(result.error, 'the refresh failure is handed back to the caller');
    assert.equal(ctx.credentialStore?.bound, true, 'credentials kept');
    assert.equal(ctx.credentialStore?.get()?.refreshToken, 'ref-1', 'refresh token not rotated');
    assert.equal(ctx.sessionStore?.liveCount() ?? 0, sessionsBefore, 'Layer-2 sessions survive');
    assert.ok(ctx.refreshTimer, 'recovery retry armed');
    clearRefreshTimer(ctx);
  });

  it('recovery retries eventually rebind once the network comes back', async () => {
    ctx = makeCtx(cloudConfig());
    await cloudLogin(
      ctx,
      { email: 'a@test', password: 'pw' },
      loader(mockSdk({ register: 0, logout: 0 })),
    );
    await refreshCloudSession(
      ctx,
      loader(mockSdk({ register: 0, logout: 0 }, { refreshThrowsTransient: true })),
    );
    assert.equal(ctx.credentialStore?.get()?.token, 'tok-a@test', 'still on the old token');

    // What the armed timer would do when it fires.
    const result = await refreshCloudSession(ctx, loader(mockSdk({ register: 0, logout: 0 })));
    assert.equal(result.outcome, 'refreshed');
    assert.equal(ctx.credentialStore?.get()?.token, 'tok-refreshed');
    assert.ok(ctx.skybridgeSession, 'session rebound');
  });

  it('reports no_credentials instead of throwing when nothing is bound', async () => {
    ctx = makeCtx(cloudConfig());
    const result = await refreshCloudSession(ctx, loader(mockSdk({ register: 0, logout: 0 })));
    assert.equal(result.outcome, 'no_credentials');
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

// ─── 0.6.2 W3 (D8): refresh-lead clamp ───────────────────────────────

describe('computeRefreshDelayMs (0.6.2 W3 / D8)', () => {
  const NOW = 1_700_000_000_000;

  it('a long-lived token refreshes one minute before expiry', () => {
    assert.equal(computeRefreshDelayMs(NOW + 30 * 86_400_000, NOW), 30 * 86_400_000 - 60_000);
    assert.equal(computeRefreshDelayMs(NOW + 120_000, NOW), 60_000);
  });

  it('a short-lived token refreshes at its midpoint, not immediately', () => {
    // Pre-fix: `max(0, ttl - 60s)` = 0 for any ttl <= 60s → a refresh storm.
    assert.equal(computeRefreshDelayMs(NOW + 30_000, NOW), 15_000);
    assert.equal(computeRefreshDelayMs(NOW + 2_000, NOW), 1_000);
  });

  it('an already-expired token still waits the 1s floor', () => {
    assert.equal(computeRefreshDelayMs(NOW - 5_000, NOW), 1_000);
  });
});
