import { beforeEach, describe, expect, it } from 'vitest';
import {
  type WebSession,
  clearWebSession,
  getWebSession,
  getWebToken,
  setWebSession,
  subscribeWebSession,
} from './web-session';

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

describe('web-session (in-memory, never persisted)', () => {
  beforeEach(() => clearWebSession());

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
