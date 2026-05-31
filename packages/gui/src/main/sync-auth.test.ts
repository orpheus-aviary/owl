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

// vi.hoisted so the class exists when the (hoisted) mock factory runs — a
// `class` declaration would otherwise be in the temporal dead zone, since the
// SUT import hoists above it.
const { MockApiError } = vi.hoisted(() => {
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
  return { MockApiError };
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
  refreshCalls: 0,
  refreshReturn: { token: 'tk-new', refreshToken: 'rt-new', expiresAt: 9_999_999 },
  refreshError: null as Error | null,
  /** Tokens whose logout() should throw TOKEN_EXPIRED (simulates short access). */
  expiredTokens: new Set<string>(),
};

vi.mock('@orpheus-aviary/skybridge-client', () => ({
  CLIENT_VERSION: '0.1.4',
  ApiError: MockApiError,
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
        if (sdkState.expiredTokens.has(token)) throw new MockApiError('TOKEN_EXPIRED');
      }),
      listDevices: vi.fn(),
      pushChanges: vi.fn(),
      pullChanges: vi.fn(),
      subscribeEvents: vi.fn(),
      revokeDevice: vi.fn(),
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
}));

vi.mock('./daemon.js', () => ({
  getDaemonUrl: vi.fn(() => 'http://127.0.0.1:47010'),
}));

// Import AFTER the mocks so the SUT picks them up.
import {
  SafeStorageUnavailableError,
  SkybridgeServerTooOldError,
  loginAndOpenSession,
  logout,
  restoreSessionOnStartup,
} from './sync-auth.js';

// ─── fetch routing ──────────────────────────────────────────────────

let switchDeviceId: string | null = null;
let sessionResp = { ok: true, status: 200 };
const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith('/sync/switch')) {
    return {
      ok: true,
      status: 200,
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

beforeEach(() => {
  vi.clearAllMocks();
  safeStorageState.available = true;
  sdkState.loginReturn.serverId = 'srv-1';
  sdkState.loginError = null;
  sdkState.registerDeviceError = null;
  sdkState.ensureWorkspaceError = null;
  sdkState.logoutCalls = 0;
  sdkState.refreshCalls = 0;
  sdkState.refreshError = null;
  sdkState.expiredTokens = new Set();
  coreState.cfgRead = null;
  coreState.cfgReadError = null;
  coreState.profileSection = null;
  coreState.writeProfileCalls = [];
  coreState.setActiveCalls = [];
  coreState.clearAuthCalls = 0;
  switchDeviceId = null;
  sessionResp = { ok: true, status: 200 };
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
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

describe('restoreSessionOnStartup (Phase 15a — access path)', () => {
  it('decrypts encrypted_token and installs the session (no switch)', async () => {
    coreState.cfgRead = profileCfg();
    const result = await restoreSessionOnStartup();
    expect(result?.device_id).toBe('dev-A');

    const sessionCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/sync/session'));
    expect(sessionCalls).toHaveLength(1);
    expect(JSON.parse((sessionCalls[0]![1] as RequestInit).body as string).token).toBe('tk-access');
    // restore must not switch — the daemon already booted into the active profile.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/sync/switch'))).toBe(false);
  });

  it('returns null for plaintext-only toml (no encrypted_token)', async () => {
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

  it('returns null when decryptString throws', async () => {
    coreState.cfgRead = profileCfg();
    safeStorageState.decryptString.mockImplementationOnce(() => {
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
