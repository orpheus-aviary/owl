import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only the transport `request` — keep ApiError real so the probe's
// `catch` sees the same class the transport throws.
vi.mock('@orpheus-aviary/owl-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orpheus-aviary/owl-shared')>();
  return { ...actual, request: vi.fn() };
});

import { ApiError, request } from '@orpheus-aviary/owl-shared';
import {
  type WebSession,
  clearWebSession,
  getWebSession,
  getWebToken,
  probeWebSession,
  setWebSession,
  subscribeWebSession,
} from './web-session';

const mockRequest = vi.mocked(request);
const STORAGE_KEY = 'owl.web.token';

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

/** A `GET /auth/session` success reply (token intentionally absent). */
const sessionReply = {
  success: true as const,
  data: { expires_at: 1_800_000_000_000, identity: SESSION.identity },
};

beforeEach(() => {
  clearWebSession();
  sessionStorage.clear();
  mockRequest.mockReset();
});

describe('web-session — in-memory state', () => {
  it('starts empty', () => {
    expect(getWebSession()).toBeNull();
    expect(getWebToken()).toBeNull();
  });

  it('set then read token + identity, clear returns to empty', () => {
    setWebSession(SESSION);
    expect(getWebToken()).toBe('tok-1');
    expect(getWebSession()).toEqual(SESSION);
    clearWebSession();
    expect(getWebSession()).toBeNull();
    expect(getWebToken()).toBeNull();
  });

  it('notifies subscribers on set + real clear, but not on a no-op clear', () => {
    let n = 0;
    const unsub = subscribeWebSession(() => n++);
    setWebSession(SESSION); // +1
    clearWebSession(); // +1
    clearWebSession(); // already null → no emit
    expect(n).toBe(2);
    unsub();
    setWebSession(SESSION); // unsubscribed → no emit
    expect(n).toBe(2);
  });
});

describe('web-session — opt-in token persistence (④ D7)', () => {
  it('persists only the token when persist is set', () => {
    setWebSession(SESSION, { persist: true });
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('tok-1');
    // Identity is never written — only the bare token.
    expect(sessionStorage.length).toBe(1);
  });

  it('does not persist by default', () => {
    setWebSession(SESSION);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('a non-persisting publish removes a stale persisted token', () => {
    setWebSession(SESSION, { persist: true });
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe('tok-1');
    // Storage strictly reflects the latest session's remember choice.
    setWebSession({ ...SESSION, token: 'tok-2' });
    expect(getWebToken()).toBe('tok-2');
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clearWebSession removes the persisted token even when memory is empty', () => {
    sessionStorage.setItem(STORAGE_KEY, 'orphan-tok');
    expect(getWebSession()).toBeNull(); // nothing in memory
    clearWebSession();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('web-session — probeWebSession rehydration', () => {
  it('returns null (no request) when there is no stored token', async () => {
    const result = await probeWebSession();
    expect(result).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('derives a full session from the stored token WITHOUT publishing', async () => {
    sessionStorage.setItem(STORAGE_KEY, 'tok-stored');
    mockRequest.mockResolvedValueOnce(sessionReply);
    const result = await probeWebSession();
    expect(mockRequest).toHaveBeenCalledWith('GET', '/auth/session');
    expect(result).toEqual({
      token: 'tok-stored', // paired from storage, not the (token-less) reply
      identity: SESSION.identity,
      expiresAt: 1_800_000_000_000,
    });
    // The coordinator publishes via activateWebSession — the probe must not.
    expect(getWebSession()).toBeNull();
  });

  it('carries the stored token as the bearer while the probe is in flight', async () => {
    sessionStorage.setItem(STORAGE_KEY, 'tok-stored');
    let resolve!: (v: typeof sessionReply) => void;
    mockRequest.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const pending = probeWebSession();
    // Mid-probe: getWebSession is still null but the transport can read the token.
    expect(getWebSession()).toBeNull();
    expect(getWebToken()).toBe('tok-stored');
    resolve(sessionReply);
    await pending;
  });

  it('clears the bad token + returns null on a probe 401', async () => {
    sessionStorage.setItem(STORAGE_KEY, 'bad-tok');
    mockRequest.mockRejectedValueOnce(new ApiError(401, 'SESSION_INVALID', 'expired'));
    const result = await probeWebSession();
    expect(result).toBeNull();
    expect(getWebToken()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('collapses concurrent probes to a single request (StrictMode double-mount)', async () => {
    sessionStorage.setItem(STORAGE_KEY, 'tok-stored');
    let resolve!: (v: typeof sessionReply) => void;
    mockRequest.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const p1 = probeWebSession();
    const p2 = probeWebSession();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    resolve(sessionReply);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(r1?.token).toBe('tok-stored');
  });
});
