import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only the transport `request` — keep ApiError real so the adapter's
// `err instanceof ApiError` branch resolves the same class.
vi.mock('@orpheus-aviary/owl-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orpheus-aviary/owl-shared')>();
  return { ...actual, request: vi.fn() };
});

import { ApiError, request } from '@orpheus-aviary/owl-shared';
import { webAdapter } from './web';
import { type WebSession, clearWebSession, getWebSession, setWebSession } from './web-session';

const mockRequest = vi.mocked(request);

const SESSION: WebSession = {
  token: 'tok-1',
  identity: {
    profile_id: 'p1',
    user_id: 'u1',
    email: 'a@b.c',
    server_url: 'http://daemon',
    device_id: 'dev-1',
    workspace_id: 'ws-1',
  },
  expiresAt: 1_700_000_000_000,
};

describe('webAdapter — basics', () => {
  it('requires auth (web host gates on login)', () => {
    expect(webAdapter.requiresAuth).toBe(true);
    expect(webAdapter.daemonBaseUrl()).toBe('');
  });

  it('omits Electron-local profile capabilities', () => {
    expect(webAdapter.sync.profiles).toBeUndefined();
    expect(webAdapter.sync.switchProfile).toBeUndefined();
    expect(webAdapter.migration).toBeUndefined();
  });
});

describe('webAdapter.sync — HTTP session ops', () => {
  beforeEach(() => {
    clearWebSession();
    mockRequest.mockReset();
  });

  it('login stores the in-memory session on success', async () => {
    mockRequest.mockResolvedValueOnce({
      success: true,
      data: {
        session_token: 'tok-xyz',
        expires_at: 999,
        identity: SESSION.identity,
      },
    });
    const reply = await webAdapter.sync.login({ serverUrl: '', email: 'a@b.c', password: 'pw' });
    expect(reply).toEqual({ ok: true, data: undefined });
    expect(getWebSession()?.token).toBe('tok-xyz');
    // serverUrl is dropped; only email/password go up.
    expect(mockRequest).toHaveBeenCalledWith('POST', '/auth/login', {
      email: 'a@b.c',
      password: 'pw',
    });
  });

  it('login surfaces the daemon message and leaves no session on 401', async () => {
    mockRequest.mockRejectedValueOnce(
      new ApiError(401, 'INVALID_CREDENTIALS', 'invalid email or password'),
    );
    const reply = await webAdapter.sync.login({ serverUrl: '', email: 'a@b.c', password: 'bad' });
    expect(reply).toEqual({ ok: false, message: 'invalid email or password' });
    expect(getWebSession()).toBeNull();
  });

  it('logout clears the session even when the remote revoke fails', async () => {
    setWebSession(SESSION);
    mockRequest.mockRejectedValueOnce(new ApiError(500, 'X', 'boom'));
    const reply = await webAdapter.sync.logout();
    expect(reply).toEqual({ ok: true, data: undefined });
    expect(getWebSession()).toBeNull();
  });

  it('status maps the in-memory identity + the daemon snapshot', async () => {
    setWebSession(SESSION);
    mockRequest.mockResolvedValueOnce({
      success: true,
      data: {
        configured: true,
        authenticated: true,
        server_url: 'http://daemon',
        device_id: 'dev-1',
        workspace_id: 'ws-1',
        pending_count: 2,
        pulled_seq: 5,
        pushed_seq: 7,
        last_sync_at: 1,
      },
    });
    const reply = await webAdapter.sync.status();
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.session?.email).toBe('a@b.c');
      expect(reply.data.snapshot?.pending_count).toBe(2);
    }
  });

  it('status keeps the identity but null snapshot when the snapshot fetch 401s', async () => {
    setWebSession(SESSION);
    mockRequest.mockRejectedValueOnce(new ApiError(401, 'SESSION_INVALID', 'expired'));
    const reply = await webAdapter.sync.status();
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.session?.email).toBe('a@b.c');
      expect(reply.data.snapshot).toBeNull();
    }
  });

  it('devices maps camelCase → snake_case + flags the current device', async () => {
    setWebSession(SESSION);
    mockRequest.mockResolvedValueOnce({
      success: true,
      data: {
        devices: [
          {
            id: 'dev-1',
            name: 'this',
            platform: 'mac',
            appVersion: 'owl 0.5.0',
            clientVersion: '0.1.4',
            createdAt: 10,
            lastSeenAt: 20,
          },
          {
            id: 'dev-2',
            name: 'other',
            platform: null,
            appVersion: null,
            clientVersion: null,
            createdAt: 30,
            lastSeenAt: 40,
          },
        ],
      },
    });
    const reply = await webAdapter.sync.devices();
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.devices[0]).toMatchObject({
        id: 'dev-1',
        app_version: 'owl 0.5.0',
        last_seen_at: 20,
        is_current: true,
      });
      expect(reply.data.devices[1]?.is_current).toBe(false);
    }
  });

  it('maps a network error (non-ApiError) to a friendly message', async () => {
    mockRequest.mockRejectedValueOnce(new Error('fetch failed'));
    const reply = await webAdapter.sync.run();
    expect(reply).toEqual({ ok: false, message: '无法连接到服务器' });
  });
});
