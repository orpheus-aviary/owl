/**
 * P5-d Phase 7 — sync-auth.ts unit tests.
 *
 * Mocks: electron safeStorage, @orpheus-aviary/skybridge-client (login +
 * createSkybridgeClient), @owl/core (readSkybridgeConfig + skybridgePath),
 * ./atomic-write.js, ./daemon.js, global fetch.
 *
 * Verifies invariants that are easy to break by inattention:
 *   - the encrypted token gets to disk; the plaintext token does NOT
 *   - POST /sync/session carries the plaintext, but nothing else does
 *   - restoreSessionOnStartup refuses plaintext-only toml (user Q裁决)
 *   - login failures unwind via best-effort remote /auth/logout
 */

import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── hoisted mocks ──────────────────────────────────────────────────

// electron.safeStorage stub — deterministic prefix-based "encryption"
// so tests can assert the base64 string corresponds to a known plaintext.
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

// @orpheus-aviary/skybridge-client mock — login + createSkybridgeClient.
const sdkState = {
  loginReturn: {
    serverUrl: 'http://127.0.0.1:18443',
    token: 'tk-plaintext',
    user: { id: 'u-A', email: 'a@test' },
  },
  loginError: null as Error | null,
  registerDeviceReturn: {
    id: 'dev-A',
    name: 'mac-a',
    app_version: '',
    client_version: '',
    last_seen_at: 0,
  },
  registerDeviceError: null as Error | null,
  // Real ApiWorkspace shape (workspace.d.ts): tool + name, no slug.
  ensureWorkspaceReturn: {
    id: 'ws-A',
    tool: 'owl',
    name: 'default',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  },
  ensureWorkspaceError: null as Error | null,
  logoutCalls: 0,
};
vi.mock('@orpheus-aviary/skybridge-client', () => ({
  CLIENT_VERSION: '0.1.3',
  login: vi.fn(async (serverUrl: string, email: string, _password: string) => {
    if (sdkState.loginError) throw sdkState.loginError;
    return { ...sdkState.loginReturn, serverUrl, user: { ...sdkState.loginReturn.user, email } };
  }),
  createSkybridgeClient: vi.fn(() => ({
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
    }),
    listDevices: vi.fn(),
    pushChanges: vi.fn(),
    pullChanges: vi.fn(),
    subscribeEvents: vi.fn(),
  })),
}));

// @owl/core mock — only the bits sync-auth.ts touches.
const coreState = {
  cfgPath: '/tmp/test-skybridge.toml',
  cfgRead: null as unknown,
  cfgReadError: null as Error | null,
};
vi.mock('@owl/core', () => ({
  readSkybridgeConfig: vi.fn(() => {
    if (coreState.cfgReadError) throw coreState.cfgReadError;
    return coreState.cfgRead;
  }),
  skybridgeConfigPath: vi.fn(() => coreState.cfgPath),
}));

// ./atomic-write.js — capture invocations + payload to verify toml content.
const atomicState = {
  writes: [] as Array<{ path: string; content: string }>,
  cleanupCalls: 0,
};
vi.mock('./atomic-write.js', () => ({
  atomicWriteFile: vi.fn((path: string, content: string) => {
    atomicState.writes.push({ path, content });
  }),
  cleanupStaleTmp: vi.fn(() => {
    atomicState.cleanupCalls += 1;
  }),
}));

// ./daemon.js — getDaemonUrl is the only surface used.
vi.mock('./daemon.js', () => ({
  getDaemonUrl: vi.fn(() => 'http://127.0.0.1:47010'),
}));

// Import AFTER all vi.mock calls so the SUT picks up mocked modules.
import {
  SafeStorageUnavailableError,
  loginAndOpenSession,
  logout,
  restoreSessionOnStartup,
} from './sync-auth.js';

// ─── shared helpers ─────────────────────────────────────────────────

function resetState(): void {
  safeStorageState.available = true;
  safeStorageState.encryptString.mockClear();
  safeStorageState.decryptString.mockClear();
  sdkState.loginError = null;
  sdkState.registerDeviceError = null;
  sdkState.ensureWorkspaceError = null;
  sdkState.logoutCalls = 0;
  coreState.cfgRead = null;
  coreState.cfgReadError = null;
  atomicState.writes = [];
  atomicState.cleanupCalls = 0;
}

const fetchMock = vi.fn();
beforeEach(() => {
  // vi.clearAllMocks resets call counts on every vi.fn / vi.mock-created
  // mock so per-test assertions like "login not called" stay isolated.
  vi.clearAllMocks();
  resetState();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function fullToml() {
  return {
    server: { url: 'http://127.0.0.1:18443' },
    auth: {
      user_id: 'u-A',
      email: 'a@test',
      encrypted_token: Buffer.from('enc:tk-plaintext', 'utf-8').toString('base64'),
    },
    device: {
      id: 'dev-A',
      name: 'mac-a',
      app_version: 'owl 0.5.0-dev',
      client_version: '0.1.3',
    },
    workspace: { id: 'ws-A', slug: 'owl/default' },
  };
}

// ─── loginAndOpenSession ─────────────────────────────────────────────

describe('loginAndOpenSession (P5-d Phase 7)', () => {
  it('writes encrypted_token to toml, posts plaintext to daemon, returns summary', async () => {
    const result = await loginAndOpenSession({
      serverUrl: 'http://127.0.0.1:18443',
      email: 'a@test',
      password: 'pw',
    });

    expect(result.device_id).toBe('dev-A');
    expect(result.workspace_id).toBe('ws-A');
    expect(result.user_id).toBe('u-A');

    // toml content must contain encrypted_token, NEVER plaintext token.
    expect(atomicState.writes).toHaveLength(1);
    const written = atomicState.writes[0]!.content;
    expect(written).toMatch(/encrypted_token = "ZW5jOnRrLXBsYWludGV4dA=="/);
    expect(written).not.toContain('tk-plaintext');
    expect(written).not.toMatch(/^token =/m);

    // POST /sync/session received the plaintext + identity fields.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:47010/sync/session');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.token).toBe('tk-plaintext');
    expect(body.user_id).toBe('u-A');
    expect(body.device.id).toBe('dev-A');
    expect(body.workspace.id).toBe('ws-A');

    // cleanupStaleTmp ran before the atomic write.
    expect(atomicState.cleanupCalls).toBe(1);
  });

  it('throws SafeStorageUnavailableError without doing a remote login when keychain is unavailable', async () => {
    safeStorageState.available = false;
    await expect(
      loginAndOpenSession({ serverUrl: 'http://x', email: 'a@b', password: 'p' }),
    ).rejects.toBeInstanceOf(SafeStorageUnavailableError);
    expect(atomicState.writes).toHaveLength(0);
    // login mock should not have been touched
    const { login } = await import('@orpheus-aviary/skybridge-client');
    expect(login).not.toHaveBeenCalled();
  });

  it('unwinds with best-effort remote logout when /sync/session fails — toml NOT written', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);

    await expect(
      loginAndOpenSession({ serverUrl: 'http://x', email: 'a@b', password: 'p' }),
    ).rejects.toThrow(/HTTP 500/);

    expect(atomicState.writes).toHaveLength(0);
    expect(sdkState.logoutCalls).toBe(1);
  });

  it('unwinds when registerDevice throws — toml NOT written, remote logout fires', async () => {
    sdkState.registerDeviceError = new Error('boom');

    await expect(
      loginAndOpenSession({ serverUrl: 'http://x', email: 'a@b', password: 'p' }),
    ).rejects.toThrow('boom');

    expect(atomicState.writes).toHaveLength(0);
    expect(sdkState.logoutCalls).toBe(1);
  });
});

// ─── logout ─────────────────────────────────────────────────────────

describe('logout (P5-d Phase 7)', () => {
  it('decrypts then revokes remote, calls /sync/logout-local, atomic-writes cleared toml', async () => {
    coreState.cfgRead = fullToml();

    await logout();

    expect(sdkState.logoutCalls).toBe(1);

    const daemonCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).endsWith('/sync/logout-local'),
    );
    expect(daemonCalls).toHaveLength(1);
    expect(daemonCalls[0]![1].method).toBe('POST');

    // toml is rewritten with [server] only
    expect(atomicState.writes).toHaveLength(1);
    const written = atomicState.writes[0]!.content;
    expect(written).toMatch(/\[server\]/);
    expect(written).not.toMatch(/\[auth\]/);
    expect(written).not.toMatch(/\[device\]/);
    expect(written).not.toMatch(/\[workspace\]/);
  });

  it('still clears toml + posts daemon teardown when remote /auth/logout fails', async () => {
    coreState.cfgRead = fullToml();
    // First fetch is daemon; SDK logout is mocked separately. Simulate SDK throw.
    const { createSkybridgeClient } = await import('@orpheus-aviary/skybridge-client');
    vi.mocked(createSkybridgeClient).mockImplementationOnce(() => ({
      registerDevice: vi.fn(),
      ensureWorkspace: vi.fn(),
      logout: vi.fn(async () => {
        throw new Error('network');
      }),
      listDevices: vi.fn(),
      pushChanges: vi.fn(),
      pullChanges: vi.fn(),
      subscribeEvents: vi.fn(),
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock shape
    })) as any;

    await logout();

    // Daemon teardown + atomic write still happened.
    expect(fetchMock).toHaveBeenCalled();
    expect(atomicState.writes).toHaveLength(1);
  });

  it('survives a missing toml — no remote logout attempt, daemon teardown still tries', async () => {
    coreState.cfgReadError = new Error('not configured');

    await logout();
    expect(sdkState.logoutCalls).toBe(0);
    // Daemon teardown still attempted as best-effort.
    expect(fetchMock).toHaveBeenCalled();
    // No toml to rewrite.
    expect(atomicState.writes).toHaveLength(0);
  });
});

// ─── restoreSessionOnStartup ─────────────────────────────────────────

describe('restoreSessionOnStartup (P5-d Phase 7)', () => {
  it('decrypts encrypted_token and posts /sync/session', async () => {
    coreState.cfgRead = fullToml();

    const result = await restoreSessionOnStartup();
    expect(result?.device_id).toBe('dev-A');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:47010/sync/session');
    const body = JSON.parse(init.body);
    expect(body.token).toBe('tk-plaintext');
  });

  it('returns null and posts NOTHING when toml carries plaintext token only (no encrypted_token)', async () => {
    // The crucial Q裁决 invariant: GUI startup refuses to promote legacy
    // plaintext through the keychain path.
    coreState.cfgRead = {
      server: { url: 'http://127.0.0.1:18443' },
      auth: { user_id: 'u-A', email: 'a@test', token: 'tk-legacy-plaintext' },
      device: { id: 'dev-A', name: 'mac-a', app_version: 'x', client_version: '0' },
      workspace: { id: 'ws-A', slug: 'owl/default' },
    };

    const result = await restoreSessionOnStartup();
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when no toml exists', async () => {
    coreState.cfgReadError = new Error('not configured');
    const result = await restoreSessionOnStartup();
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when safeStorage is unavailable', async () => {
    coreState.cfgRead = fullToml();
    safeStorageState.available = false;

    const result = await restoreSessionOnStartup();
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when decryptString throws', async () => {
    coreState.cfgRead = fullToml();
    safeStorageState.decryptString.mockImplementationOnce(() => {
      throw new Error('keychain locked');
    });

    const result = await restoreSessionOnStartup();
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when device or workspace identity is incomplete', async () => {
    const partial = fullToml();
    partial.workspace = undefined as never;
    coreState.cfgRead = partial;

    const result = await restoreSessionOnStartup();
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
