/**
 * P5-d Phase 8 — sync-ipc.ts unit tests.
 *
 * Covers all three handlers + the `extractSession` gate that mirrors
 * `restoreSessionOnStartup`'s safeStorage + decrypt-probe (v4 design).
 *
 * Mock surface:
 *   - electron: `ipcMain.handle` captures handler functions into a map;
 *               `safeStorage.{isEncryptionAvailable, decryptString}` are
 *               driven directly to exercise the v4 availability gate.
 *   - ./sync-auth.js: loginAndOpenSession + logout + SafeStorageUnavailableError.
 *   - @orpheus-aviary/skybridge-client: real ApiError / NetworkError classes.
 *   - @owl/core: readSkybridgeConfig is mocked per test.
 *   - ./daemon.js: getDaemonUrl returns a known URL.
 *   - global fetch: mocked per test for /sync/status snapshot path.
 */

import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── hoisted mocks ──────────────────────────────────────────────────

const handlerMap = new Map<string, (...args: unknown[]) => unknown>();
const safeStorageState = {
  available: true,
  decryptString: vi.fn((b: Buffer) => b.toString('utf-8')),
};
// Phase 16 (B7): drives `notifyProfileSwitched` — getAllWindows()[0].webContents.send.
const windowState = {
  hasWindow: true,
  destroyed: false,
  send: vi.fn(),
};
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlerMap.set(channel, handler);
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => safeStorageState.available,
    decryptString: (b: Buffer) => safeStorageState.decryptString(b),
  },
  BrowserWindow: {
    getAllWindows: () =>
      windowState.hasWindow
        ? [{ isDestroyed: () => windowState.destroyed, webContents: { send: windowState.send } }]
        : [],
  },
}));

const authState = {
  loginError: null as Error | null,
  logoutError: null as Error | null,
  loginCalls: [] as Array<{ serverUrl: string; email: string; password: string }>,
  logoutCalls: 0,
};
vi.mock('./sync-auth.js', () => ({
  loginAndOpenSession: vi.fn(
    async (input: { serverUrl: string; email: string; password: string }) => {
      authState.loginCalls.push(input);
      if (authState.loginError) throw authState.loginError;
      return {
        server_url: input.serverUrl,
        user_id: 'u-A',
        email: input.email,
        device_id: 'dev-A',
        workspace_id: 'ws-A',
      };
    },
  ),
  logout: vi.fn(async () => {
    authState.logoutCalls += 1;
    if (authState.logoutError) throw authState.logoutError;
  }),
  // Real error class so `err instanceof SafeStorageUnavailableError` works.
  SafeStorageUnavailableError: class SafeStorageUnavailableError extends Error {
    readonly code = 'SAFE_STORAGE_UNAVAILABLE';
    constructor() {
      super('safe storage unavailable');
      this.name = 'SafeStorageUnavailableError';
    }
  },
}));

// Real ApiError / NetworkError classes so `instanceof` narrowing in `safe()`
// behaves identically to production.
vi.mock('@orpheus-aviary/skybridge-client', async () => {
  const actual = await vi.importActual<typeof import('@orpheus-aviary/skybridge-client')>(
    '@orpheus-aviary/skybridge-client',
  );
  return { ApiError: actual.ApiError, NetworkError: actual.NetworkError };
});

const coreState = {
  readReturn: null as unknown,
  readError: null as Error | null,
};
vi.mock('@owl/core', () => ({
  readSkybridgeConfig: vi.fn(() => {
    if (coreState.readError) throw coreState.readError;
    return coreState.readReturn;
  }),
}));

vi.mock('./daemon.js', () => ({
  getDaemonUrl: () => 'http://127.0.0.1:47010',
}));

// ─── lazy import after mocks ────────────────────────────────────────

const { registerSyncIpc } = await import('./sync-ipc.js');
const { ApiError, NetworkError } = await import('@orpheus-aviary/skybridge-client');
const { SafeStorageUnavailableError } = await import('./sync-auth.js');

type IpcReply<T> = { ok: true; data: T } | { ok: false; message: string };

function call(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlerMap.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  // Pretend to be an IpcMainInvokeEvent — `_event` is not read.
  return Promise.resolve(handler({}, ...args));
}

// ─── setup ──────────────────────────────────────────────────────────

const FULL_CFG = {
  server: { url: 'http://srv' },
  auth: {
    user_id: 'u-A',
    email: 'a@test',
    encrypted_token: Buffer.from('plaintext-tk', 'utf-8').toString('base64'),
  },
  device: { id: 'dev-A', name: 'mac-a', app_version: '', client_version: '' },
  workspace: { id: 'ws-A', slug: 'owl/default' },
};

beforeEach(() => {
  handlerMap.clear();
  authState.loginError = null;
  authState.logoutError = null;
  authState.loginCalls = [];
  authState.logoutCalls = 0;
  coreState.readReturn = null;
  coreState.readError = null;
  safeStorageState.available = true;
  safeStorageState.decryptString = vi.fn((b: Buffer) => b.toString('utf-8'));
  windowState.hasWindow = true;
  windowState.destroyed = false;
  windowState.send = vi.fn();
  registerSyncIpc();
});

/** Flush the macrotask queue so `setImmediate`-deferred notifies run. */
const flushImmediate = (): Promise<void> => new Promise((r) => setImmediate(r));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── tests ──────────────────────────────────────────────────────────

describe('profile:switched notify (B7)', () => {
  it('login success → sends profile:switched after the reply', async () => {
    const reply = (await call('sync:login', {
      serverUrl: 'http://srv',
      email: 'a@test',
      password: 'pw',
    })) as IpcReply<void>;
    expect(reply.ok).toBe(true);
    // Deferred via setImmediate so the invoke reply returns first.
    expect(windowState.send).not.toHaveBeenCalled();
    await flushImmediate();
    expect(windowState.send).toHaveBeenCalledWith('profile:switched');
  });

  it('logout success → sends profile:switched', async () => {
    await call('sync:logout');
    await flushImmediate();
    expect(windowState.send).toHaveBeenCalledWith('profile:switched');
  });

  it('login failure → does NOT notify', async () => {
    authState.loginError = new ApiError('INVALID_CREDENTIALS', 401, 'bad creds');
    const reply = (await call('sync:login', {
      serverUrl: 'http://srv',
      email: 'a',
      password: 'p',
    })) as IpcReply<void>;
    expect(reply.ok).toBe(false);
    await flushImmediate();
    expect(windowState.send).not.toHaveBeenCalled();
  });

  it('no window present → notify is a no-op (no throw)', async () => {
    windowState.hasWindow = false;
    await call('sync:logout');
    await expect(flushImmediate()).resolves.toBeUndefined();
    expect(windowState.send).not.toHaveBeenCalled();
  });
});

describe('sync:login', () => {
  it('success → { ok: true, data: undefined } (summary discarded)', async () => {
    const reply = (await call('sync:login', {
      serverUrl: 'http://srv',
      email: 'a@test',
      password: 'pw',
    })) as IpcReply<void>;
    // Exact match — see v3 lock on success shape.
    expect(reply).toEqual({ ok: true, data: undefined });
    expect(authState.loginCalls).toEqual([
      { serverUrl: 'http://srv', email: 'a@test', password: 'pw' },
    ]);
  });

  it('ApiError(INVALID_CREDENTIALS) → 邮箱或密码不正确', async () => {
    authState.loginError = new ApiError('INVALID_CREDENTIALS', 401, 'bad creds');
    const reply = (await call('sync:login', {
      serverUrl: 'http://srv',
      email: 'a',
      password: 'p',
    })) as IpcReply<void>;
    expect(reply).toEqual({ ok: false, message: '邮箱或密码不正确' });
  });

  it('NetworkError → 网络连接失败…', async () => {
    authState.loginError = new NetworkError('TCP reset');
    const reply = (await call('sync:login', {
      serverUrl: 'http://srv',
      email: 'a',
      password: 'p',
    })) as IpcReply<void>;
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toMatch(/网络连接失败/);
  });

  it('SafeStorageUnavailableError → 系统钥匙串不可用…', async () => {
    authState.loginError = new SafeStorageUnavailableError();
    const reply = (await call('sync:login', {
      serverUrl: 'http://srv',
      email: 'a',
      password: 'p',
    })) as IpcReply<void>;
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toMatch(/系统钥匙串不可用/);
  });

  it('plain Error → unknown fallback with detail', async () => {
    authState.loginError = new Error('weird');
    const reply = (await call('sync:login', {
      serverUrl: 'http://srv',
      email: 'a',
      password: 'p',
    })) as IpcReply<void>;
    expect(reply).toEqual({ ok: false, message: '同步出错：weird' });
  });
});

describe('sync:logout', () => {
  it('success → { ok: true, data: undefined }', async () => {
    const reply = (await call('sync:logout')) as IpcReply<void>;
    expect(reply).toEqual({ ok: true, data: undefined });
    expect(authState.logoutCalls).toBe(1);
  });
});

describe('sync:status — session derivation', () => {
  // Stub fetch globally for the snapshot leg of buildStatus().
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                configured: true,
                authenticated: true,
                server_url: 'http://srv',
                device_id: 'dev-A',
                workspace_id: 'ws-A',
                pending_count: 0,
                pulled_seq: 1,
                pushed_seq: 1,
                last_sync_at: 12345,
              },
            }),
            { status: 200 },
          ),
      ),
    );
  });

  it('full encrypted cfg + safeStorage available + decrypt OK → session present + snapshot', async () => {
    coreState.readReturn = FULL_CFG;
    const reply = (await call('sync:status')) as IpcReply<{
      session: unknown;
      snapshot: unknown;
    }>;
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data.session).toEqual({
      email: 'a@test',
      server_url: 'http://srv',
      workspace_slug: 'owl/default',
      workspace_id: 'ws-A',
      device_id: 'dev-A',
      device_name: 'mac-a',
    });
    expect(reply.data.snapshot).toMatchObject({
      configured: true,
      authenticated: true,
      pending_count: 0,
    });
  });

  it('legacy plaintext-only toml (auth.token without encrypted_token) → session null', async () => {
    // readSkybridgeConfig drops `auth` entirely unless hasAnyToken is true,
    // but we simulate a hand-edited toml that left plaintext token only.
    coreState.readReturn = {
      ...FULL_CFG,
      auth: { user_id: 'u-A', email: 'a@test', token: 'legacy-pt' },
    };
    const reply = (await call('sync:status')) as IpcReply<{ session: unknown }>;
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.data.session).toBeNull();
  });

  it('workspace missing → session null (no throw)', async () => {
    coreState.readReturn = { ...FULL_CFG, workspace: undefined };
    const reply = (await call('sync:status')) as IpcReply<{ session: unknown }>;
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.data.session).toBeNull();
  });

  it('daemon /sync/status unreachable → snapshot null, session still derived', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    coreState.readReturn = FULL_CFG;
    const reply = (await call('sync:status')) as IpcReply<{
      session: unknown;
      snapshot: unknown;
    }>;
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data.snapshot).toBeNull();
    expect(reply.data.session).not.toBeNull();
  });

  it('readSkybridgeConfig throws (no toml) → session null + snapshot still attempted', async () => {
    coreState.readError = new Error('no toml');
    const reply = (await call('sync:status')) as IpcReply<{
      session: unknown;
      snapshot: unknown;
    }>;
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.data.session).toBeNull();
  });

  // v4 additions: align extractSession with restoreSessionOnStartup gate.
  it('v4: safeStorage.isEncryptionAvailable=false → session null even with full cfg', async () => {
    safeStorageState.available = false;
    coreState.readReturn = FULL_CFG;
    const reply = (await call('sync:status')) as IpcReply<{ session: unknown }>;
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      // Settings must NOT lie — startup restore would return null here.
      expect(reply.data.session).toBeNull();
    }
  });

  it('v4: encrypted_token present but decryptString throws → session null', async () => {
    safeStorageState.decryptString = vi.fn(() => {
      throw new Error('keychain locked');
    });
    coreState.readReturn = FULL_CFG;
    const reply = (await call('sync:status')) as IpcReply<{ session: unknown }>;
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.data.session).toBeNull();
  });

  it('workspace.slug empty string normalises to null in reply', async () => {
    coreState.readReturn = {
      ...FULL_CFG,
      workspace: { id: 'ws-A', slug: '' },
    };
    const reply = (await call('sync:status')) as IpcReply<{
      session: { workspace_slug: string | null } | null;
    }>;
    expect(reply.ok).toBe(true);
    if (reply.ok && reply.data.session) {
      expect(reply.data.session.workspace_slug).toBeNull();
    }
  });
});

// ─── sync:devices (P5-d Phase 10) ───────────────────────────────────

describe('sync:devices', () => {
  // Wire shape returned by daemon (camelCase ApiDevice from the SDK).
  const DEVICE_A = {
    id: 'dev-A',
    name: 'mac-a (owl)',
    platform: 'darwin',
    appVersion: 'owl 0.4.2',
    clientVersion: '0.1.3',
    createdAt: 1700000000000,
    lastSeenAt: 1700000100000,
  };
  const DEVICE_B = {
    id: 'dev-B',
    name: 'mac-b (owl)',
    platform: 'darwin',
    appVersion: 'owl 0.4.2',
    clientVersion: '0.1.3',
    createdAt: 1700000200000,
    lastSeenAt: 1700000300000,
  };

  function stubDaemonDevices(devices: object[], status = 200): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { devices } }), { status })),
    );
  }

  it('happy path: maps camelCase → snake_case + computes is_current from toml device.id', async () => {
    coreState.readReturn = FULL_CFG; // FULL_CFG.device.id === 'dev-A'
    stubDaemonDevices([DEVICE_A, DEVICE_B]);
    const reply = (await call('sync:devices')) as IpcReply<{
      devices: Array<{ id: string; is_current: boolean; app_version: string | null }>;
    }>;
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data.devices).toHaveLength(2);
    expect(reply.data.devices[0]).toMatchObject({
      id: 'dev-A',
      app_version: 'owl 0.4.2',
      is_current: true,
    });
    expect(reply.data.devices[1]).toMatchObject({
      id: 'dev-B',
      is_current: false,
    });
  });

  it('no toml device.id → is_current false for all', async () => {
    coreState.readReturn = { ...FULL_CFG, device: undefined };
    stubDaemonDevices([DEVICE_A]);
    const reply = (await call('sync:devices')) as IpcReply<{
      devices: Array<{ is_current: boolean }>;
    }>;
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.data.devices[0]?.is_current).toBe(false);
  });

  it('daemon 401 envelope → ok:false + 中文 message from daemon body', async () => {
    coreState.readReturn = FULL_CFG;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error_code: 'SKYBRIDGE_AUTH_REQUIRED',
              message: 'skybridge token rejected (401); 请在设置中重新登录',
            }),
            { status: 401 },
          ),
      ),
    );
    const reply = (await call('sync:devices')) as IpcReply<unknown>;
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toMatch(/请在设置中重新登录/);
  });

  it('fetch rejects (daemon down) → NetworkError → 网络连接失败…', async () => {
    coreState.readReturn = FULL_CFG;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const reply = (await call('sync:devices')) as IpcReply<unknown>;
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toMatch(/网络连接失败/);
  });

  it('empty devices array passes through', async () => {
    coreState.readReturn = FULL_CFG;
    stubDaemonDevices([]);
    const reply = (await call('sync:devices')) as IpcReply<{ devices: unknown[] }>;
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.data.devices).toEqual([]);
  });
});

// P5-d Phase 17 (W8) — `sync:run` drives daemon POST /sync/run. Mirrors the
// devices error-translation shape (daemon envelope.message verbatim / bare
// fetch failure → NetworkError → Chinese). No profile change → never notifies.
describe('sync:run', () => {
  const RUN_RESULT = {
    pulledTotal: 3,
    appliedTotal: 2,
    skippedTotal: 1,
    pushedTotal: 4,
    duplicatesTotal: 0,
    serverSeqHigh: 42,
    cursorBefore: 38,
    cursorAfter: 42,
    conflictsRecorded: 0,
  };

  it('happy path: returns daemon RunSyncResult, does NOT notify profile:switched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: RUN_RESULT }), { status: 200 })),
    );
    // Drain any setImmediate-deferred notify queued by an earlier test, then
    // take a fresh send mock so this negative assertion only sees the effect
    // of THIS handler (sync:run must never fire profile:switched).
    await flushImmediate();
    windowState.send = vi.fn();
    const reply = (await call('sync:run')) as IpcReply<typeof RUN_RESULT>;
    await flushImmediate();
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.data).toMatchObject({ pushedTotal: 4, conflictsRecorded: 0 });
    expect(windowState.send).not.toHaveBeenCalled();
  });

  it('daemon error envelope → ok:false + 中文 message from daemon body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error_code: 'SKYBRIDGE_AUTH_REQUIRED',
              message: 'skybridge token rejected (401); 请在设置中重新登录',
            }),
            { status: 401 },
          ),
      ),
    );
    const reply = (await call('sync:run')) as IpcReply<unknown>;
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toMatch(/请在设置中重新登录/);
  });

  it('fetch rejects (daemon down) → NetworkError → 网络连接失败…', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const reply = (await call('sync:run')) as IpcReply<unknown>;
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.message).toMatch(/网络连接失败/);
  });

  it('200 but no data → ok:false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    const reply = (await call('sync:run')) as IpcReply<unknown>;
    expect(reply.ok).toBe(false);
  });
});
