/**
 * 0.6.2 W3 — automatic recovery from `auth_required` (GUI main side).
 *
 * The three traps the module is shaped around each get a test:
 *   - the switch queue is non-reentrant (a naive implementation deadlocks);
 *   - the internal backoff retry must NOT go through the external 10s rate
 *     limit, or the retry is swallowed and nothing re-arms the timer;
 *   - a profile switch that wins the queue must turn an already-queued
 *     recovery into a no-op, not a refresh of the wrong account.
 */

import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeStorageState = {
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf-8')),
  decryptString: vi.fn((b: Buffer) => b.toString('utf-8').replace(/^enc:/, '')),
};
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => safeStorageState.encryptString(s),
    decryptString: (b: Buffer) => safeStorageState.decryptString(b),
  },
}));

const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, status = 401) {
      super(code);
      this.code = code;
      this.status = status;
      this.name = 'ApiError';
    }
  }
  return { MockApiError };
});

const sdkState = {
  refreshCalls: 0,
  refreshReturn: { token: 'tk-new', refreshToken: 'rt-new', expiresAt: 0 },
  refreshError: null as Error | null,
};
vi.mock('@orpheus-aviary/skybridge-client', () => ({
  ApiError: MockApiError,
  refresh: vi.fn(async () => {
    sdkState.refreshCalls += 1;
    if (sdkState.refreshError) throw sdkState.refreshError;
    return sdkState.refreshReturn;
  }),
}));

const coreState = {
  cfg: null as unknown,
  clearAuthCalls: 0,
  updateAuthCalls: 0,
};
vi.mock('@owl/core', () => ({
  readSkybridgeConfig: vi.fn(() => coreState.cfg),
  clearSkybridgeAuth: vi.fn(() => {
    coreState.clearAuthCalls += 1;
  }),
  updateActiveProfileAuth: vi.fn(() => {
    coreState.updateAuthCalls += 1;
  }),
}));

vi.mock('./daemon.js', () => ({ getDaemonUrl: vi.fn(() => 'http://127.0.0.1:47010') }));
vi.mock('./daemon-auth.js', () => ({
  daemonAuthHeaders: () => ({ authorization: 'Bearer test-local' }),
  getLocalTokenPath: () => '/tmp/owl-test/daemon-token',
}));

import {
  __resetRecoveryForTests,
  bumpRecoveryGeneration,
  requestRecovery,
} from './sync-auth-recovery.js';
import { clearRefreshTimer, getCurrentExpiresAt } from './sync-auth-renewal.js';
import { __resetSwitchQueueForTests, runSwitchExclusive } from './sync-switch-queue.js';

const BASE = 1_700_000_000_000;

let sessionOk = true;
const fetchMock = vi.fn(async (url: string | URL) => {
  const u = String(url);
  if (u.endsWith('/sync/session'))
    return { ok: sessionOk, status: sessionOk ? 200 : 500 } as Response;
  return { ok: true, status: 200 } as Response;
});

function b64(plain: string): string {
  return Buffer.from(`enc:${plain}`, 'utf-8').toString('base64');
}

function cfg() {
  return {
    server: { url: 'http://127.0.0.1:18443' },
    auth: {
      user_id: 'u-A',
      email: 'a@test',
      encrypted_token: b64('tk-access'),
      encrypted_refresh_token: b64('rt-refresh'),
    },
    device: { id: 'dev-A', name: 'mac-a' },
    workspace: { id: 'ws-A', slug: 'owl/default' },
  };
}

/** URLs POSTed, in order. */
const posted = (): string[] => fetchMock.mock.calls.map(([u]) => String(u));
const sessionPosts = (): number => posted().filter((u) => u.endsWith('/sync/session')).length;

/** Let queued promises settle without advancing the clock meaningfully. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
  vi.stubGlobal('fetch', fetchMock);
  sessionOk = true;
  sdkState.refreshCalls = 0;
  sdkState.refreshError = null;
  sdkState.refreshReturn = { token: 'tk-new', refreshToken: 'rt-new', expiresAt: BASE + 3_600_000 };
  coreState.cfg = cfg();
  coreState.clearAuthCalls = 0;
  clearRefreshTimer();
  __resetSwitchQueueForTests();
  __resetRecoveryForTests();
});

describe('requestRecovery — reason dispatch', () => {
  it('missing_session re-installs the stored token WITHOUT refreshing', async () => {
    requestRecovery('missing_session');
    await flush();

    expect(sdkState.refreshCalls).toBe(0);
    expect(sessionPosts()).toBe(1);
  });

  it('token_rejected refreshes first — re-installing a rejected token would loop', async () => {
    requestRecovery('token_rejected');
    await flush();

    expect(sdkState.refreshCalls).toBe(1);
    expect(sessionPosts()).toBe(1);
  });

  it('credentials_missing is a no-op (terminal)', async () => {
    requestRecovery('credentials_missing');
    await flush();

    expect(sdkState.refreshCalls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a dead refresh token clears the credentials and tells the daemon', async () => {
    sdkState.refreshError = new MockApiError('REFRESH_INVALID');
    requestRecovery('token_rejected');
    await flush();

    expect(coreState.clearAuthCalls).toBe(1);
    expect(posted().some((u) => u.endsWith('/sync/auth-unrecoverable'))).toBe(true);
  });
});

describe('requestRecovery — rate limiting vs internal retry', () => {
  it('two external requests inside 10s collapse to one attempt', async () => {
    requestRecovery('missing_session');
    await flush();
    vi.setSystemTime(BASE + 5_000);
    requestRecovery('missing_session');
    await flush();

    expect(sessionPosts()).toBe(1);
  });

  // Found on the 0.6.2 real-device run: daemon restart → `missing_session` →
  // reinstall the stored (expired) token → SSE subscribe 401 → `token_rejected`,
  // all inside ~1.5s. A single shared throttle timestamp dropped the escalation
  // and nothing rearmed it, so the app sat at「需登录」forever.
  it('an ESCALATED reason inside the throttle window is not dropped', async () => {
    requestRecovery('missing_session');
    await flush();
    expect(sessionPosts()).toBe(1);
    expect(sdkState.refreshCalls).toBe(0);

    vi.setSystemTime(BASE + 1_500); // well inside the 10s window
    requestRecovery('token_rejected');
    await flush();

    expect(sdkState.refreshCalls).toBe(1); // the rejected token really got refreshed
    expect(sessionPosts()).toBe(2);
  });

  it('the 2s backoff retry is NOT swallowed by the 10s external throttle', async () => {
    sessionOk = false; // install keeps failing → schedules the internal retry
    requestRecovery('missing_session');
    await flush();
    expect(sessionPosts()).toBe(1);

    // Still inside the external 10s window: an external caller would be
    // dropped here, but the internal retry must fire anyway — nothing else
    // would ever re-arm the recovery chain.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sessionPosts()).toBe(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sessionPosts()).toBe(3);
  });
});

describe('requestRecovery — profile-switch safety', () => {
  it('a recovery queued behind a switch becomes a no-op', async () => {
    // Hold the switch queue the way a profile switch would.
    let release: () => void = () => {};
    const blocker = new Promise<void>((r) => {
      release = r;
    });
    const held = runSwitchExclusive(() => blocker);

    requestRecovery('token_rejected');
    await flush();
    expect(sdkState.refreshCalls).toBe(0); // still waiting for the queue

    // The "switch" completes and, as the orchestrator does, invalidates every
    // in-flight recovery before releasing.
    bumpRecoveryGeneration();
    release();
    await held;
    await flush();

    expect(sdkState.refreshCalls).toBe(0); // must not refresh the profile we switched to
    expect(sessionPosts()).toBe(0);
  });

  it('a scheduled backoff retry is cancelled by a switch', async () => {
    sessionOk = false;
    requestRecovery('missing_session');
    await flush();
    expect(sessionPosts()).toBe(1);

    bumpRecoveryGeneration();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sessionPosts()).toBe(1); // the pending retry belonged to the old profile
  });

  it('does not deadlock when recovery runs while another queued op is pending', async () => {
    const order: string[] = [];
    const queued = runSwitchExclusive(async () => {
      order.push('other');
    });
    requestRecovery('missing_session');
    await queued;
    await flush();

    expect(order).toEqual(['other']);
    expect(sessionPosts()).toBe(1);
  });
});

describe('refreshed_not_installed', () => {
  it('keeps the renewal timer armed and retries only the install', async () => {
    sessionOk = false;
    requestRecovery('token_rejected');
    await flush();

    // The rotation succeeded, so the next renewal must already be scheduled —
    // the old code let an install failure kill renewal entirely.
    expect(sdkState.refreshCalls).toBe(1);
    expect(getCurrentExpiresAt()).toBe(BASE + 3_600_000);

    // The retry re-installs; it must not burn another rotation.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sdkState.refreshCalls).toBe(1);
    expect(sessionPosts()).toBe(2);
  });
});
