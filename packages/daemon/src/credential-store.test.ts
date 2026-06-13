/**
 * Phase A (A3) — CredentialStore unit tests (RAM-only Layer-1 credentials).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CloudCredentials, CredentialStore } from './credential-store.js';

function creds(): CloudCredentials {
  return {
    serverUrl: 'http://127.0.0.1:18443',
    serverId: 'srv-1',
    userId: 'u-1',
    email: 'owner@test',
    profileId: '0123456789abcdef0123456789abcdef',
    deviceId: 'dev-1',
    workspaceId: 'ws-1',
    token: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 1000,
  };
}

describe('CredentialStore', () => {
  it('starts unbound and round-trips set/get', () => {
    const store = new CredentialStore();
    assert.equal(store.bound, false);
    assert.equal(store.get(), null);
    const c = creds();
    store.set(c);
    assert.equal(store.bound, true);
    assert.equal(store.get()?.token, 'access-1');
    assert.equal(store.get()?.profileId, '0123456789abcdef0123456789abcdef');
  });

  it('rotate swaps the token + refresh + expiry, keeping identity', () => {
    const store = new CredentialStore();
    store.set(creds());
    store.rotate({ token: 'access-2', refreshToken: 'refresh-2', expiresAt: 2000 });
    const c = store.get();
    assert.equal(c?.token, 'access-2');
    assert.equal(c?.refreshToken, 'refresh-2');
    assert.equal(c?.expiresAt, 2000);
    // identity untouched
    assert.equal(c?.userId, 'u-1');
    assert.equal(c?.deviceId, 'dev-1');
    assert.equal(c?.workspaceId, 'ws-1');
  });

  it('rotate keeps the prior refresh token when the server returns none', () => {
    const store = new CredentialStore();
    store.set(creds());
    store.rotate({ token: 'access-2', expiresAt: 2000 });
    assert.equal(store.get()?.refreshToken, 'refresh-1');
  });

  it('rotate throws when nothing is bound', () => {
    const store = new CredentialStore();
    assert.throws(() => store.rotate({ token: 'x' }), /no credentials set/);
  });

  it('clear unbinds', () => {
    const store = new CredentialStore();
    store.set(creds());
    store.clear();
    assert.equal(store.bound, false);
    assert.equal(store.get(), null);
  });
});
