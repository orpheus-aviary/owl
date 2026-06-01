/**
 * P5-d Phase 15 — sync-auth.ts unit tests (per-profile login/logout).
 *
 * Mocks: electron safeStorage, @orpheus-aviary/skybridge-client (login /
 * refresh / createSkybridgeClient / ApiError), @owl/core (the profile config
 * writers + readSkybridgeConfig / readProfileSection / computeProfileId), and
 * global fetch (routes /sync/switch + /sync/session).
 *
 * Verifies the Phase 15 invariants:
 *   - login switches the daemon onto the profile db, reuses or registers the
 *     device, installs the session, and writes [profiles.<id>] (setActive)
 *     with encrypted access + refresh — never plaintext
 *   - a server with no server_id is rejected (R5)
 *   - login failures unwind: remote logout + switch back to local, no toml
 *   - logout revokes (refresh-then-logout when the access token has expired),
 *     switches to local, clears the active profile's creds, repoints active
 *   - restoreSessionOnStartup installs the session from encrypted_token
 */

import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── hoisted mocks ──────────────────────────────────────────────────

const safeStorageState = {
  available: true,
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf-8')),
  decryptString: vi.fn((b: Buffer) => b.toString('utf-8').replace(/^enc:/, '')),
};
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => safeStorageState.available,
    encryptString: (s: string) => safeStorageState.encryptString(s),
    decryptString: (b: Buffer) => safeStorageState.decryptString(b),
  },
}));

// Phase 16: existsSync(profileDbPath) drives the return-visit vs first-login
// split; mkdirSync is a no-op (the claim copy is mocked). Records nothing.
const fsState = { profileDbExists: false };
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => fsState.profileDbExists), mkdirSync: vi.fn() };
});

// Phase 16: the claim prompt is exercised without electron/BrowserWindow.
const claimState = { choice: 'independent' as 'merge' | 'independent', calls: 0 };
vi.mock('./claim-prompt.js', () => ({
  promptClaim: vi.fn(async () => {
    claimState.calls += 1;
    return claimState.choice;
  }),
}));

// vi.hoisted so the class exists when the (hoisted) mock factory runs — a
// `class` declaration would otherwise be in the temporal dead zone, since the
// SUT import hoists above it.
const { MockApiError, MockProfileDbMissingError, MockNetworkError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status = 401, message = '') {
      super(message);
      this.code = code;
      this.status = status;
      this.name = 'ApiError';
    }
  }
  class MockProfileDbMissingError extends Error {
    readonly code = 'SKYBRIDGE_PROFILE_DB_MISSING';
    constructor(public readonly profileId: string) {
      super(`cannot activate profile ${profileId}: its db does not exist`);
      this.name = 'ProfileDbMissingError';
    }
  }
  class MockNetworkError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NetworkError';
    }
  }
  return { MockApiError, MockProfileDbMissingError, MockNetworkError };
});

const sdkState = {
  loginReturn: {
    serverUrl: 'http://127.0.0.1:18443',
    token: 'tk-plaintext',
    refreshToken: 'rt-refresh',
    expiresAt: 9_999_999,
    serverId: 'srv-1' as string | undefined,
    user: { id: 'u-A', email: 'a@test', displayName: null },
  },
  loginError: null as Error | null,
  registerDeviceReturn: { id: 'dev-A', name: 'mac-a' },
  registerDeviceError: null as Error | null,
  ensureWorkspaceReturn: { id: 'ws-A', tool: 'owl', name: 'default' },
  ensureWorkspaceError: null as Error | null,
  logoutCalls: 0,
  revokeDeviceCalls: [] as string[],
  refreshCalls: 0,
  refreshReturn: { token: 'tk-new', refreshToken: 'rt-new', expiresAt: 9_999_999 },
  refreshError: null as Error | null,
  /** Tokens whose logout() should throw TOKEN_EXPIRED (simulates short access). */
  expiredTokens: new Set<string>(),
  /** Phase 16: pull probe result. Default = empty account (latestSeq 0). */
  pullReturn: {
    changes: [] as unknown[],
    hasMore: false,
    latestSeq: 0,
    serverTime: 0,
  },
};

vi.mock('@orpheus-aviary/skybridge-client', () => ({
  CLIENT_VERSION: '0.1.4',
  ApiError: MockApiError,
  NetworkError: MockNetworkError,
  login: vi.fn(async (serverUrl: string, email: string) => {
    if (sdkState.loginError) throw sdkState.loginError;
    return { ...sdkState.loginReturn, serverUrl, user: { ...sdkState.loginReturn.user, email } };
  }),
  refresh: vi.fn(async () => {
    sdkState.refreshCalls += 1;
    if (sdkState.refreshError) throw sdkState.refreshError;
    return sdkState.refreshReturn;
  }),
  createSkybridgeClient: vi.fn((opts: { authContext: { token: string } }) => {
    const token = opts.authContext.token;
    return {
      registerDevice: vi.fn(async () => {
        if (sdkState.registerDeviceError) throw sdkState.registerDeviceError;
        return sdkState.registerDeviceReturn;
      }),
      ensureWorkspace: vi.fn(async () => {
        if (sdkState.ensureWorkspaceError) throw sdkState.ensureWorkspaceError;
        return sdkState.ensureWorkspaceReturn;
      }),
      logout: vi.fn(async () => {
        sdkState.logoutCalls += 1;
        callLog.push('logout');
        if (sdkState.expiredTokens.has(token)) throw new MockApiError('TOKEN_EXPIRED');
      }),
      listDevices: vi.fn(),
      pushChanges: vi.fn(),
      pullChanges: vi.fn(async () => sdkState.pullReturn),
      subscribeEvents: vi.fn(),
      revokeDevice: vi.fn(async (id: string) => {
        sdkState.revokeDeviceCalls.push(id);
        callLog.push('revoke');
        if (sdkState.expiredTokens.has(token)) throw new MockApiError('TOKEN_EXPIRED');
      }),
    };
  }),
}));

const coreState = {
  cfgRead: null as unknown,
  cfgReadError: null as Error | null,
  profileSection: null as unknown,
  writeProfileCalls: [] as Array<{
    profileId: string;
    section: Record<string, unknown>;
    opts: unknown;
  }>,
  setActiveCalls: [] as string[],
  clearAuthCalls: 0,
  updateAuthCalls: [] as Array<Record<string, unknown>>,
  // Phase 16
  localInspect: { noteCount: 0, hasSyncTraces: false },
  copyCalls: [] as string[],
  // Phase 17 (W4)
  effectiveActive: 'local',
  updateProfileAuthCalls: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  clearProfileAuthCalls: [] as string[],
  // Phase 17 (delete-local-copy)
  deleteDbCalls: [] as string[],
  removeProfileCalls: [] as string[],
};
vi.mock('@owl/core', () => ({
  OWL_APP_VERSION: '0.5.0-dev',
  LOCAL_PROFILE: 'local',
  readSkybridgeConfig: vi.fn(() => {
    if (coreState.cfgReadError) throw coreState.cfgReadError;
    return coreState.cfgRead;
  }),
  computeProfileId: vi.fn((serverId: string, userId: string) => `pid-${serverId}-${userId}`),
  normalizeServerUrl: vi.fn((u: string) => u.replace(/\/+$/, '')),
  readProfileSection: vi.fn(() => coreState.profileSection),
  writeProfileConfig: vi.fn(
    (profileId: string, section: Record<string, unknown>, opts: unknown) => {
      coreState.writeProfileCalls.push({ profileId, section, opts });
    },
  ),
  setActiveProfile: vi.fn((id: string) => {
    coreState.setActiveCalls.push(id);
  }),
  clearSkybridgeAuth: vi.fn(() => {
    coreState.clearAuthCalls += 1;
  }),
  updateActiveProfileAuth: vi.fn((patch: Record<string, unknown>) => {
    coreState.updateAuthCalls.push(patch);
  }),
  // Phase 17 (W4)
  ProfileDbMissingError: MockProfileDbMissingError,
  readEffectiveActiveProfileId: vi.fn(() => coreState.effectiveActive),
  updateProfileAuth: vi.fn((id: string, patch: Record<string, unknown>) => {
    coreState.updateProfileAuthCalls.push({ id, patch });
    callLog.push('update');
  }),
  clearProfileAuth: vi.fn((id: string) => {
    coreState.clearProfileAuthCalls.push(id);
  }),
  // Phase 17 (delete-local-copy)
  deleteProfileDb: vi.fn((id: string) => {
    coreState.deleteDbCalls.push(id);
  }),
  removeProfile: vi.fn((id: string) => {
    coreState.removeProfileCalls.push(id);
  }),
  // Phase 16
  paths: {
    profileDbPath: (id: string) => `/nest/owl/profiles/${id}/owl.db`,
    localProfileDbPath: () => '/nest/owl/owl.db',
  },
  inspectLocalProfile: vi.fn(() => coreState.localInspect),
  copyLocalProfileDbInto: vi.fn(async (target: string) => {
    coreState.copyCalls.push(target);
    callLog.push('copy');
  }),
}));

vi.mock('./daemon.js', () => ({
  getDaemonUrl: vi.fn(() => 'http://127.0.0.1:47010'),
}));

// Import AFTER the mocks so the SUT picks them up.
import {
  QuickSwitchNeedsLoginError,
  SafeStorageUnavailableError,
  SkybridgeServerTooOldError,
  clearRefreshTimer,
  deleteProfileLocalCopy,
  loginAndOpenSession,
  logout,
  maybeRefreshNow,
  restoreSessionOnStartup,
  switchToProfile,
} from './sync-auth.js';

// ─── fetch routing ──────────────────────────────────────────────────

let switchDeviceId: string | null = null;
let sessionResp = { ok: true, status: 200 };
// Phase 17 (delete): drive postSyncSwitchStrict — a non-2xx is an HTTP failure
// (abort delete), a thrown fetch is a daemon-down NetworkError (continue).
let switchResp = { ok: true, status: 200 };
let switchThrows = false;
// Phase 16: orders the claim copy vs the daemon switch (B9: copy must precede
// switch). Pushed by the copy mock ('copy') and the switch fetch ('switch').
let callLog: string[] = [];
const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith('/sync/switch')) {
    if (switchThrows) throw new Error('ECONNREFUSED');
    callLog.push('switch');
    return {
      ok: switchResp.ok,
      status: switchResp.status,
      json: async () => ({ data: { device_id: switchDeviceId } }),
    } as unknown as Response;
  }
  if (u.endsWith('/sync/session')) {
    return { ok: sessionResp.ok, status: sessionResp.status } as Response;
  }
  return { ok: true, status: 200 } as Response;
});

function b64(plain: string): string {
  return Buffer.from(`enc:${plain}`, 'utf-8').toString('base64');
}

function profileCfg(over: Record<string, unknown> = {}) {
  return {
    server: { url: 'http://127.0.0.1:18443' },
    auth: {
      user_id: 'u-A',
      email: 'a@test',
      encrypted_token: b64('tk-access'),
      encrypted_refresh_token: b64('rt-refresh'),
    },
    device: { id: 'dev-A', name: 'mac-a', app_version: 'owl 0.5.0-dev', client_version: '0.1.4' },
    workspace: { id: 'ws-A', slug: 'owl/default' },
    ...over,
  };
}

// Fixed clock so `expiresAt` math + the renewal timer are deterministic.
const BASE = 1_700_000_000_000;
const FAR = BASE + 3_600_000; // 1h ahead → "fresh"

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  clearRefreshTimer(); // module-level singleton — reset between tests
  // clearAllMocks resets call counts but NOT implementations, so re-establish
  // the default safeStorage behavior (a test may have stubbed it to throw).
  safeStorageState.encryptString.mockImplementation((s: string) =>
    Buffer.from(`enc:${s}`, 'utf-8'),
  );
  safeStorageState.decryptString.mockImplementation((b: Buffer) =>
    b.toString('utf-8').replace(/^enc:/, ''),
  );
  safeStorageState.available = true;
  sdkState.loginReturn.serverId = 'srv-1';
  sdkState.loginReturn.expiresAt = FAR;
  sdkState.loginError = null;
  sdkState.registerDeviceError = null;
  sdkState.ensureWorkspaceError = null;
  sdkState.logoutCalls = 0;
  sdkState.revokeDeviceCalls = [];
  sdkState.refreshCalls = 0;
  sdkState.refreshError = null;
  sdkState.refreshReturn = { token: 'tk-new', refreshToken: 'rt-new', expiresAt: FAR };
  sdkState.expiredTokens = new Set();
  coreState.cfgRead = null;
  coreState.cfgReadError = null;
  coreState.profileSection = null;
  coreState.writeProfileCalls = [];
  coreState.setActiveCalls = [];
  coreState.clearAuthCalls = 0;
  coreState.updateAuthCalls = [];
  coreState.localInspect = { noteCount: 0, hasSyncTraces: false };
  coreState.copyCalls = [];
  coreState.effectiveActive = 'local';
  coreState.updateProfileAuthCalls = [];
  coreState.clearProfileAuthCalls = [];
  coreState.deleteDbCalls = [];
  coreState.removeProfileCalls = [];
  sdkState.pullReturn = { changes: [], hasMore: false, latestSeq: 0, serverTime: 0 };
  fsState.profileDbExists = false;
  claimState.choice = 'independent';
  claimState.calls = 0;
  callLog = [];
  switchDeviceId = null;
  sessionResp = { ok: true, status: 200 };
  switchResp = { ok: true, status: 200 };
  switchThrows = false;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  clearRefreshTimer();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ─── loginAndOpenSession ─────────────────────────────────────────────

describe('loginAndOpenSession (Phase 15)', () => {
  it('switches to the profile, registers a fresh device, installs + writes [profiles.<id>]', async () => {
    const result = await loginAndOpenSession({
      serverUrl: 'http://127.0.0.1:18443',
      email: 'a@test',
      password: 'pw',
    });

    expect(result).toEqual({
      server_url: 'http://127.0.0.1:18443',
      user_id: 'u-A',
      email: 'a@test',
      device_id: 'dev-A',
      workspace_id: 'ws-A',
    });

    // /sync/switch posted the computed profile id; /sync/session carried plaintext.
    const switchCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/sync/switch'));
    expect(JSON.parse((switchCall![1] as RequestInit).body as string).profile_id).toBe(
      'pid-srv-1-u-A',
    );
    const sessionCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/sync/session'));
    const sessionBody = JSON.parse((sessionCall![1] as RequestInit).body as string);
    expect(sessionBody.token).toBe('tk-plaintext');
    expect(sessionBody.device.id).toBe('dev-A');
    expect(sessionBody.workspace.id).toBe('ws-A');

    // toml: one writeProfileConfig({setActive}) with both ciphertexts, no plaintext.
    expect(coreState.writeProfileCalls).toHaveLength(1);
    const { profileId, section, opts } = coreState.writeProfileCalls[0]!;
    expect(profileId).toBe('pid-srv-1-u-A');
    expect(opts).toEqual({ setActive: true });
    expect(section.server_id).toBe('srv-1');
    expect(section.server_url).toBe('http://127.0.0.1:18443');
    expect(section.encrypted_token).toBe(b64('tk-plaintext'));
    expect(section.encrypted_refresh_token).toBe(b64('rt-refresh'));
    expect(section.token).toBeUndefined();
    expect(JSON.stringify(section)).not.toContain('tk-plaintext');
  });

  it('rejects a server with no server_id (R5) — remote logout, no toml written', async () => {
    sdkState.loginReturn.serverId = undefined;
    await expect(
      loginAndOpenSession({ serverUrl: 'http://x', email: 'a@b', password: 'p' }),
    ).rejects.toBeInstanceOf(SkybridgeServerTooOldError);
    expect(coreState.writeProfileCalls).toHaveLength(0);
    expect(sdkState.logoutCalls).toBe(1); // bestEffortRemoteLogout
  });

  it('reuses the remembered device (stored meta) — no registerDevice', async () => {
    fsState.profileDbExists = true; // return visit
    switchDeviceId = 'dev-existing';
    coreState.profileSection = {
      device: {
        id: 'dev-existing',
        name: 'old-name',
        app_version: 'owl old',
        client_version: '0.1.3',
      },
    };

    const result = await loginAndOpenSession({
      serverUrl: 'http://127.0.0.1:18443',
      email: 'a@test',
      password: 'pw',
    });

    expect(result.device_id).toBe('dev-existing');
    const sessionCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/sync/session'));
    expect(JSON.parse((sessionCall![1] as RequestInit).body as string).device).toMatchObject({
      id: 'dev-existing',
      name: 'old-name',
    });
    // registerDevice would have been on a createSkybridgeClient instance; assert
    // the written section carried the reused id.
    expect(coreState.writeProfileCalls[0]!.section.device).toMatchObject({ id: 'dev-existing' });
  });

  it('reuses by synthesising device meta when no stored section exists', async () => {
    fsState.profileDbExists = true; // return visit
    switchDeviceId = 'dev-existing';
    coreState.profileSection = null;
    const result = await loginAndOpenSession({
      serverUrl: 'http://127.0.0.1:18443',
      email: 'a@test',
      password: 'pw',
    });
    expect(result.device_id).toBe('dev-existing');
    const section = coreState.writeProfileCalls[0]!.section.device as { id: string; name: string };
    expect(section.id).toBe('dev-existing');
    expect(section.name.length).toBeGreaterThan(0); // defaultDeviceName()
  });

  it('throws SafeStorageUnavailableError before any remote login', async () => {
    safeStorageState.available = false;
    await expect(
      loginAndOpenSession({ serverUrl: 'http://x', email: 'a@b', password: 'p' }),
    ).rejects.toBeInstanceOf(SafeStorageUnavailableError);
    const { login } = await import('@orpheus-aviary/skybridge-client');
    expect(login).not.toHaveBeenCalled();
    expect(coreState.writeProfileCalls).toHaveLength(0);
  });

  it('unwinds on /sync/session failure — remote logout, switch back to local, no toml', async () => {
    sessionResp = { ok: false, status: 500 };
    await expect(
      loginAndOpenSession({ serverUrl: 'http://x', email: 'a@b', password: 'p' }),
    ).rejects.toThrow(/HTTP 500/);

    expect(coreState.writeProfileCalls).toHaveLength(0);
    expect(sdkState.logoutCalls).toBe(1);
    // The last /sync/switch was the rollback to local.
    const switchCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/sync/switch'));
    const last = JSON.parse((switchCalls.at(-1)![1] as RequestInit).body as string);
    expect(last.profile_id).toBe('local');
  });
});

// ─── claim-empty-account (Phase 16, D10b) ───────────────────────────

describe('loginAndOpenSession — claim empty account (Phase 16)', () => {
  const login = () =>
    loginAndOpenSession({ serverUrl: 'http://127.0.0.1:18443', email: 'a@test', password: 'pw' });

  it('first login + empty account + local has notes + merge → copies BEFORE switch', async () => {
    fsState.profileDbExists = false; // first login
    coreState.localInspect = { noteCount: 5, hasSyncTraces: false };
    claimState.choice = 'merge';

    await login();

    expect(claimState.calls).toBe(1);
    expect(coreState.copyCalls).toEqual(['/nest/owl/profiles/pid-srv-1-u-A/owl.db']);
    // B9: the claim copy must land before the daemon switches onto the target.
    expect(callLog).toEqual(['copy', 'switch']);
  });

  it('first login + empty account + local has notes + independent → no copy', async () => {
    coreState.localInspect = { noteCount: 5, hasSyncTraces: false };
    claimState.choice = 'independent';

    await login();

    expect(claimState.calls).toBe(1);
    expect(coreState.copyCalls).toHaveLength(0);
    expect(callLog).toEqual(['switch']); // switch still creates an empty db
  });

  it('first login + empty account + local empty → no prompt, no copy', async () => {
    coreState.localInspect = { noteCount: 0, hasSyncTraces: false };

    await login();

    expect(claimState.calls).toBe(0);
    expect(coreState.copyCalls).toHaveLength(0);
  });

  it('first login + NON-empty account → no prompt (pure pull), never merges local', async () => {
    coreState.localInspect = { noteCount: 5, hasSyncTraces: false };
    sdkState.pullReturn = { changes: [{}], hasMore: false, latestSeq: 7, serverTime: 0 };

    await login();

    expect(claimState.calls).toBe(0);
    expect(coreState.copyCalls).toHaveLength(0);
  });

  it('return visit (profile db exists) → no probe, no prompt', async () => {
    fsState.profileDbExists = true;
    switchDeviceId = 'dev-existing';
    coreState.localInspect = { noteCount: 5, hasSyncTraces: false };

    await login();

    expect(claimState.calls).toBe(0);
    expect(coreState.copyCalls).toHaveLength(0);
  });
});

// ─── multi-account add: login while already on an account (D-add) ────

describe('loginAndOpenSession — multi-account add (D-add)', () => {
  /** A full prior-account section (read by the rollback's planQuickSwitch). */
  function priorSection(over: Record<string, unknown> = {}) {
    return {
      server_id: 'srv-A',
      server_url: 'http://srv-a:8443',
      user_id: 'u-A',
      email: 'a@test',
      encrypted_token: b64('tk-A-access'),
      encrypted_refresh_token: b64('rt-A-refresh'),
      device: { id: 'dev-A', name: 'mac-a', app_version: 'owl 0.5.0-dev', client_version: '0.1.4' },
      workspace: { id: 'ws-A', slug: 'owl/default' },
      ...over,
    };
  }
  const switchProfileIds = () =>
    fetchMock.mock.calls
      .filter(([u]) => String(u).endsWith('/sync/switch'))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string).profile_id);
  const login = () =>
    loginAndOpenSession({ serverUrl: 'http://127.0.0.1:18443', email: 'a@test', password: 'pw' });

  it('logging in from an account adds + switches to the new account; never prompts claim (D-add-3)', async () => {
    coreState.effectiveActive = 'pid-A'; // already on account A
    fsState.profileDbExists = false; // first login to the new account on this machine
    coreState.localInspect = { noteCount: 5, hasSyncTraces: false }; // local HAS notes

    await login();

    // Claim is the local-only on-ramp: adding FROM an account never merges local
    // (contrast the from-local claim tests above, where prior === local).
    expect(claimState.calls).toBe(0);
    expect(coreState.copyCalls).toHaveLength(0);
    // Switched onto the new account + wrote only its section (A's stays saved).
    expect(switchProfileIds()).toEqual(['pid-srv-1-u-A']);
    expect(coreState.writeProfileCalls).toHaveLength(1);
    expect(coreState.writeProfileCalls[0]!.profileId).toBe('pid-srv-1-u-A');
    expect(coreState.writeProfileCalls[0]!.opts).toEqual({ setActive: true });
  });

  it('login failure from an account rolls the daemon back to the PRIOR account (not local)', async () => {
    coreState.effectiveActive = 'pid-A';
    coreState.profileSection = priorSection(); // read by the rollback's planQuickSwitch(A)
    fsState.profileDbExists = false;
    sessionResp = { ok: false, status: 500 }; // /sync/session fails

    await expect(login()).rejects.toThrow(/HTTP 500/);

    // Switched onto the new account, then rolled the daemon back to A — never local.
    expect(switchProfileIds()).toEqual(['pid-srv-1-u-A', 'pid-A']);
    expect(switchProfileIds()).not.toContain('local');
    expect(coreState.writeProfileCalls).toHaveLength(0);
    expect(sdkState.logoutCalls).toBe(1); // revoked the freshly-issued token
  });

  it('a bad password does not stop the prior account renewal timer', async () => {
    // Establish a live renewal timer for account A (login from local).
    coreState.cfgRead = profileCfg();
    await loginAndOpenSession({ serverUrl: 'http://x', email: 'a@test', password: 'p' });
    sdkState.refreshCalls = 0;
    coreState.effectiveActive = 'pid-srv-1-u-A'; // now on A

    // Attempt to add another account, but the remote login fails (wrong password).
    sdkState.loginError = new Error('bad password');
    await expect(login()).rejects.toThrow(/bad password/);

    // A's timer is untouched (login throws before clearRefreshTimer): advancing
    // to A's renewal point still fires exactly one refresh.
    await vi.advanceTimersByTimeAsync(FAR - BASE - 60_000);
    expect(sdkState.refreshCalls).toBe(1);
  });

  it('re-login to the CURRENT account re-installs, reuses the device, overwrites its secrets', async () => {
    coreState.effectiveActive = 'pid-srv-1-u-A'; // already on this exact account
    fsState.profileDbExists = true; // its db exists (return visit / self-switch)
    switchDeviceId = 'dev-A'; // daemon remembers the device
    coreState.profileSection = priorSection();

    await login();

    expect(switchProfileIds()).toEqual(['pid-srv-1-u-A']);
    expect(coreState.writeProfileCalls).toHaveLength(1);
    const { profileId, section } = coreState.writeProfileCalls[0]!;
    expect(profileId).toBe('pid-srv-1-u-A'); // [profiles.<A>] still written for the same id
    expect((section.device as { id: string }).id).toBe('dev-A'); // device reused
    expect((section.workspace as { id: string }).id).toBe('ws-A'); // workspace reused
    expect(section.encrypted_token).toBe(b64('tk-plaintext')); // secrets overwritten by this login
    expect(section.encrypted_refresh_token).toBe(b64('rt-refresh'));
  });

  it('re-login to the current account that fails rolls back to itself, never local', async () => {
    coreState.effectiveActive = 'pid-srv-1-u-A';
    fsState.profileDbExists = true;
    switchDeviceId = 'dev-A';
    coreState.profileSection = priorSection();
    sessionResp = { ok: false, status: 500 };

    await expect(login()).rejects.toThrow();

    expect(switchProfileIds()).toEqual(['pid-srv-1-u-A', 'pid-srv-1-u-A']);
    expect(switchProfileIds()).not.toContain('local');
  });
});

// ─── logout ─────────────────────────────────────────────────────────

describe('logout (Phase 15 — full logout / D2)', () => {
  it('revokes, switches to local, clears active creds, repoints active=local', async () => {
    coreState.cfgRead = profileCfg();

    await logout();

    expect(sdkState.logoutCalls).toBe(1); // access logout revoked the family
    const switchCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/sync/switch'));
    expect(JSON.parse((switchCalls.at(-1)![1] as RequestInit).body as string).profile_id).toBe(
      'local',
    );
    expect(coreState.clearAuthCalls).toBe(1);
    expect(coreState.setActiveCalls).toEqual(['local']);
  });

  it('refreshes then revokes when the access token has expired', async () => {
    coreState.cfgRead = profileCfg();
    sdkState.expiredTokens = new Set(['tk-access']); // access logout throws TOKEN_EXPIRED

    await logout();

    expect(sdkState.refreshCalls).toBe(1);
    expect(sdkState.logoutCalls).toBe(2); // first (expired) threw, second (refreshed) ok
    expect(coreState.setActiveCalls).toEqual(['local']);
  });

  it('survives a missing toml — no revoke, still switches local + clears + repoints', async () => {
    coreState.cfgReadError = new Error('not configured');
    await logout();
    expect(sdkState.logoutCalls).toBe(0);
    const switchCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/sync/switch'));
    expect(switchCalls).toHaveLength(1);
    expect(coreState.setActiveCalls).toEqual(['local']);
  });
});

// ─── restoreSessionOnStartup ─────────────────────────────────────────

describe('restoreSessionOnStartup (Phase 15b — refresh-first)', () => {
  it('refreshes the access token, rotates, installs (no switch), schedules renewal', async () => {
    coreState.cfgRead = profileCfg();
    const result = await restoreSessionOnStartup();
    expect(result?.device_id).toBe('dev-A');

    expect(sdkState.refreshCalls).toBe(1);
    expect(coreState.updateAuthCalls).toHaveLength(1); // rotation persisted
    expect(coreState.updateAuthCalls[0]).toMatchObject({
      encrypted_token: b64('tk-new'),
      encrypted_refresh_token: b64('rt-new'),
    });
    const sessionCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/sync/session'));
    expect(sessionCalls).toHaveLength(1);
    expect(JSON.parse((sessionCalls[0]![1] as RequestInit).body as string).token).toBe('tk-new');
    // no switch — daemon already booted into the active profile.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/sync/switch'))).toBe(false);
  });

  it('falls back to the stored access token when there is no refresh token (legacy)', async () => {
    coreState.cfgRead = profileCfg({
      auth: { user_id: 'u-A', email: 'a@test', encrypted_token: b64('tk-access') },
    });
    const result = await restoreSessionOnStartup();
    expect(result?.device_id).toBe('dev-A');
    expect(sdkState.refreshCalls).toBe(0);
    const sessionCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/sync/session'));
    expect(JSON.parse((sessionCalls[0]![1] as RequestInit).body as string).token).toBe('tk-access');
  });

  it('drops creds + returns null on a dead refresh token (REFRESH_REPLAYED)', async () => {
    coreState.cfgRead = profileCfg();
    sdkState.refreshError = new MockApiError('REFRESH_REPLAYED');
    expect(await restoreSessionOnStartup()).toBeNull();
    expect(coreState.clearAuthCalls).toBe(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/sync/session'))).toBe(false);
  });

  it('keeps creds + returns null on a transient refresh failure (network)', async () => {
    coreState.cfgRead = profileCfg();
    sdkState.refreshError = new Error('network down');
    expect(await restoreSessionOnStartup()).toBeNull();
    expect(coreState.clearAuthCalls).toBe(0); // token preserved for a later retry
  });

  it('returns null for plaintext-only toml (no ciphertext at all)', async () => {
    coreState.cfgRead = profileCfg({
      auth: { user_id: 'u-A', email: 'a@test', token: 'legacy-plaintext' },
    });
    expect(await restoreSessionOnStartup()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when no toml exists', async () => {
    coreState.cfgReadError = new Error('not configured');
    expect(await restoreSessionOnStartup()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when safeStorage is unavailable', async () => {
    coreState.cfgRead = profileCfg();
    safeStorageState.available = false;
    expect(await restoreSessionOnStartup()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when the keychain cannot decrypt', async () => {
    coreState.cfgRead = profileCfg();
    safeStorageState.decryptString.mockImplementation(() => {
      throw new Error('keychain locked');
    });
    expect(await restoreSessionOnStartup()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when workspace identity is incomplete', async () => {
    coreState.cfgRead = profileCfg({ workspace: undefined });
    expect(await restoreSessionOnStartup()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── proactive renewal ───────────────────────────────────────────────

describe('proactive renewal (Phase 15b)', () => {
  async function loginFresh(): Promise<void> {
    coreState.cfgRead = profileCfg();
    await loginAndOpenSession({ serverUrl: 'http://x', email: 'a@test', password: 'p' });
    sdkState.refreshCalls = 0; // ignore any refresh during setup
  }

  it('maybeRefreshNow is a no-op when there is no session', async () => {
    await maybeRefreshNow();
    expect(sdkState.refreshCalls).toBe(0);
  });

  it('maybeRefreshNow is a no-op while the access token is still fresh', async () => {
    await loginFresh(); // installs a FAR-future expiry
    await maybeRefreshNow();
    expect(sdkState.refreshCalls).toBe(0);
  });

  it('maybeRefreshNow renews once the token is at/near expiry', async () => {
    sdkState.loginReturn.expiresAt = BASE + 1_000; // inside the 60s margin
    await loginFresh();
    await maybeRefreshNow();
    expect(sdkState.refreshCalls).toBe(1);
  });

  it('logout stops renewal (maybeRefreshNow no longer fires)', async () => {
    await loginFresh();
    await logout();
    sdkState.refreshCalls = 0;
    await maybeRefreshNow();
    expect(sdkState.refreshCalls).toBe(0);
  });

  // Regression: a long-lived access token (server default TTL is 30 days) makes
  // `expiresAt - now - margin` exceed setTimeout's 32-bit ceiling (~24.8 days).
  // Passing that straight to setTimeout clamped it to 1ms and fired immediately
  // → an infinite refresh+reinstall storm. The timer must chunk: sleep the max,
  // re-evaluate, re-arm — never refresh early in a tight loop.
  it('does NOT refresh-loop when the renewal delay exceeds setTimeout 32-bit max', async () => {
    sdkState.loginReturn.expiresAt = BASE + 30 * 86_400_000; // delay ≫ 2^31-1
    await loginFresh();

    // Pre-fix this fired at ~1ms (setTimeout overflow). Advancing well past that
    // must NOT refresh.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sdkState.refreshCalls).toBe(0);

    // It re-arms at the ~24.8-day ceiling; the re-arm only recomputes the
    // remaining delay (token still has days left) — it must not refresh.
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(sdkState.refreshCalls).toBe(0);
  });
});

// ─── switchToProfile (Phase 17 / W4) ─────────────────────────────────

describe('switchToProfile (Phase 17 / W4)', () => {
  /** The target profile's stored section (flat ProfileConfigSection shape). */
  function accountSection(over: Record<string, unknown> = {}) {
    return {
      server_id: 'srv-B',
      server_url: 'http://srv-b:8443',
      user_id: 'u-B',
      email: 'b@test',
      encrypted_token: b64('tk-B-access'),
      encrypted_refresh_token: b64('rt-B-refresh'),
      device: { id: 'dev-B', name: 'mac-b', app_version: 'owl 0.5.0-dev', client_version: '0.1.4' },
      workspace: { id: 'ws-B', slug: 'owl/default' },
      ...over,
    };
  }
  const switchProfileIds = () =>
    fetchMock.mock.calls
      .filter(([u]) => String(u).endsWith('/sync/switch'))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string).profile_id);

  it('switch to local: step-away — switches + setActive(local), no revoke / no token clear', async () => {
    coreState.effectiveActive = 'pid-A'; // currently on an account
    await switchToProfile('local');
    expect(switchProfileIds()).toEqual(['local']);
    expect(coreState.setActiveCalls).toEqual(['local']);
    expect(sdkState.logoutCalls).toBe(0); // no revoke (D2 step-away)
    expect(coreState.clearAuthCalls).toBe(0);
    expect(coreState.clearProfileAuthCalls).toEqual([]);
    expect(sdkState.refreshCalls).toBe(0);
  });

  it('switch to account: refresh → persist-first (before switch) → switch → install → setActive', async () => {
    coreState.effectiveActive = 'local';
    coreState.profileSection = accountSection();
    fsState.profileDbExists = true;
    await switchToProfile('pid-B');

    expect(sdkState.refreshCalls).toBe(1);
    // ② persist-first: updateProfileAuth on the target ran BEFORE /sync/switch.
    expect(coreState.updateProfileAuthCalls).toHaveLength(1);
    expect(coreState.updateProfileAuthCalls[0]).toMatchObject({
      id: 'pid-B',
      patch: { encrypted_token: b64('tk-new'), encrypted_refresh_token: b64('rt-new') },
    });
    expect(callLog.indexOf('update')).toBeLessThan(callLog.indexOf('switch'));
    expect(switchProfileIds()).toEqual(['pid-B']);
    const sessionCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/sync/session'));
    expect(JSON.parse((sessionCall![1] as RequestInit).body as string).token).toBe('tk-new');
    expect(coreState.setActiveCalls).toEqual(['pid-B']);
  });

  it('⑩ db-missing hard gate: refuses before refresh — no refresh / no switch / no empty db', async () => {
    coreState.effectiveActive = 'local';
    coreState.profileSection = accountSection();
    fsState.profileDbExists = false; // ghost — section present but db gone
    await expect(switchToProfile('pid-B')).rejects.toThrow(/db does not exist/);
    expect(sdkState.refreshCalls).toBe(0); // gated before refresh
    expect(switchProfileIds()).toEqual([]); // never reached /sync/switch
    expect(coreState.setActiveCalls).toEqual([]);
  });

  it('dead refresh: clears the target creds, never touches the daemon', async () => {
    coreState.effectiveActive = 'local';
    coreState.profileSection = accountSection();
    fsState.profileDbExists = true;
    sdkState.refreshError = new MockApiError('REFRESH_INVALID');
    await expect(switchToProfile('pid-B')).rejects.toThrow();
    expect(coreState.clearProfileAuthCalls).toEqual(['pid-B']);
    expect(switchProfileIds()).toEqual([]); // daemon untouched
    expect(coreState.setActiveCalls).toEqual([]);
  });

  it('no refresh token (legacy section) → QuickSwitchNeedsLoginError, no refresh / no switch', async () => {
    coreState.effectiveActive = 'local';
    coreState.profileSection = accountSection({ encrypted_refresh_token: undefined });
    fsState.profileDbExists = true;
    await expect(switchToProfile('pid-B')).rejects.toBeInstanceOf(QuickSwitchNeedsLoginError);
    expect(sdkState.refreshCalls).toBe(0);
    expect(switchProfileIds()).toEqual([]);
  });

  it('no-op when target is already the effective active profile', async () => {
    coreState.effectiveActive = 'pid-B';
    await switchToProfile('pid-B');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(coreState.setActiveCalls).toEqual([]);
  });

  it('install failure after switch → rolls the daemon back to the prior account', async () => {
    coreState.effectiveActive = 'pid-A'; // prior is an account
    coreState.profileSection = accountSection(); // read for B + the rollback re-establish
    fsState.profileDbExists = true;
    sessionResp = { ok: false, status: 500 }; // /sync/session fails (target + rollback)
    await expect(switchToProfile('pid-B')).rejects.toThrow();
    // switched onto B (target), then rolled the daemon back to A.
    expect(switchProfileIds()).toEqual(['pid-B', 'pid-A']);
  });

  it('install failure with a local prior → rolls back to local', async () => {
    coreState.effectiveActive = 'local';
    coreState.profileSection = accountSection();
    fsState.profileDbExists = true;
    sessionResp = { ok: false, status: 500 };
    await expect(switchToProfile('pid-B')).rejects.toThrow();
    expect(switchProfileIds()).toEqual(['pid-B', 'local']);
    expect(coreState.setActiveCalls).toContain('local'); // rollback re-points local
  });
});

// ─── deleteProfileLocalCopy (Phase 17 / delete-local-copy) ───────────

describe('deleteProfileLocalCopy (Phase 17 / destructive)', () => {
  function accountSection(over: Record<string, unknown> = {}) {
    return {
      server_id: 'srv-B',
      server_url: 'http://srv-b:8443',
      user_id: 'u-B',
      email: 'b@test',
      encrypted_token: b64('tk-B-access'),
      encrypted_refresh_token: b64('rt-B-refresh'),
      device: { id: 'dev-B', name: 'mac-b', app_version: 'owl 0.5.0-dev', client_version: '0.1.4' },
      workspace: { id: 'ws-B', slug: 'owl/default' },
      ...over,
    };
  }
  const switchProfileIds = () =>
    fetchMock.mock.calls
      .filter(([u]) => String(u).endsWith('/sync/switch'))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string).profile_id);

  it('active delete: hard-switches local, revokes device-first/logout-last, deletes db + toml', async () => {
    coreState.effectiveActive = 'pid-B';
    coreState.profileSection = accountSection();
    await deleteProfileLocalCopy('pid-B');

    expect(switchProfileIds()).toEqual(['local']); // ④ handle released
    expect(coreState.setActiveCalls).toEqual(['local']);
    // ③ device-first / logout-last
    expect(sdkState.revokeDeviceCalls).toEqual(['dev-B']);
    expect(callLog.indexOf('revoke')).toBeLessThan(callLog.indexOf('logout'));
    expect(coreState.deleteDbCalls).toEqual(['pid-B']);
    expect(coreState.removeProfileCalls).toEqual(['pid-B']);
  });

  it('active delete returns { wasActive: true }', async () => {
    coreState.effectiveActive = 'pid-B';
    coreState.profileSection = accountSection();
    expect(await deleteProfileLocalCopy('pid-B')).toEqual({ wasActive: true });
  });

  it('④ HTTP switch failure aborts the delete (db + toml untouched)', async () => {
    coreState.effectiveActive = 'pid-B';
    coreState.profileSection = accountSection();
    switchResp = { ok: false, status: 500 }; // daemon up but switch failed
    await expect(deleteProfileLocalCopy('pid-B')).rejects.toThrow();
    expect(coreState.deleteDbCalls).toEqual([]); // never deleted
    expect(coreState.removeProfileCalls).toEqual([]);
  });

  it('④ daemon unreachable (NetworkError) → continues the delete', async () => {
    coreState.effectiveActive = 'pid-B';
    coreState.profileSection = accountSection();
    switchThrows = true; // fetch rejects → NetworkError → no handle held
    const result = await deleteProfileLocalCopy('pid-B');
    expect(result).toEqual({ wasActive: true });
    expect(coreState.deleteDbCalls).toEqual(['pid-B']);
    expect(coreState.removeProfileCalls).toEqual(['pid-B']);
  });

  it('non-active delete: no daemon switch, just remote cleanup + db + toml', async () => {
    coreState.effectiveActive = 'local';
    coreState.profileSection = accountSection();
    const result = await deleteProfileLocalCopy('pid-B');
    expect(result).toEqual({ wasActive: false });
    expect(switchProfileIds()).toEqual([]); // daemon untouched
    expect(coreState.deleteDbCalls).toEqual(['pid-B']);
    expect(coreState.removeProfileCalls).toEqual(['pid-B']);
  });

  it('⑨ refresh-only profile: refreshes to mint access, then device-first/logout-last', async () => {
    coreState.effectiveActive = 'local';
    coreState.profileSection = accountSection({ encrypted_token: undefined }); // refresh only
    await deleteProfileLocalCopy('pid-B');
    expect(sdkState.refreshCalls).toBeGreaterThanOrEqual(1); // minted an access
    expect(sdkState.revokeDeviceCalls).toEqual(['dev-B']);
    expect(callLog.indexOf('revoke')).toBeLessThan(callLog.indexOf('logout'));
  });

  it('skips remote cleanup when neither access nor refresh is usable, still deletes locally', async () => {
    coreState.effectiveActive = 'local';
    coreState.profileSection = accountSection({
      encrypted_token: undefined,
      encrypted_refresh_token: undefined,
    });
    await deleteProfileLocalCopy('pid-B');
    expect(sdkState.revokeDeviceCalls).toEqual([]); // no usable token → remote skipped
    expect(sdkState.logoutCalls).toBe(0);
    expect(coreState.deleteDbCalls).toEqual(['pid-B']); // local delete still runs
    expect(coreState.removeProfileCalls).toEqual(['pid-B']);
  });
});
