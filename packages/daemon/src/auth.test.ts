/**
 * Phase A (A2) — SessionStore + auth helper unit tests.
 *
 * The clock is injected so sliding-TTL / expiry are deterministic without
 * real time. Mirrors design §4.2 / §5.3.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SessionStore, bearerToken, isPublicPath } from './auth.js';

describe('SessionStore', () => {
  it('mints unique opaque tokens bound to a profileId', () => {
    const store = new SessionStore(1000);
    const a = store.mint('owner-1');
    const b = store.mint('owner-1');
    assert.notEqual(a.token, b.token);
    assert.equal(a.profileId, 'owner-1');
    assert.equal(store.size, 2);
  });

  it('verify returns the session and slides expiry on use', () => {
    let t = 1000;
    const store = new SessionStore(100, () => t);
    const { token, expiresAt } = store.mint('p');
    assert.equal(expiresAt, 1100);
    t = 1050;
    const s = store.verify(token);
    assert.ok(s);
    assert.equal(s?.expiresAt, 1150); // slid forward by ttl from now
  });

  it('verify returns null + revokes a session past its expiry', () => {
    let t = 0;
    const store = new SessionStore(100, () => t);
    const { token } = store.mint('p');
    t = 101;
    assert.equal(store.verify(token), null);
    assert.equal(store.size, 0);
  });

  it('verify returns null for an unknown token', () => {
    const store = new SessionStore(100);
    assert.equal(store.verify('nope'), null);
  });

  it('revoke runs registered teardown callbacks (e.g. close SSE)', () => {
    const store = new SessionStore(1000);
    const { token } = store.mint('p');
    let closed = 0;
    store.onTeardown(token, () => {
      closed++;
    });
    store.revoke(token);
    assert.equal(closed, 1);
    assert.equal(store.size, 0);
  });

  it('an unregistered teardown does not fire on revoke', () => {
    const store = new SessionStore(1000);
    const { token } = store.mint('p');
    let closed = 0;
    const off = store.onTeardown(token, () => {
      closed++;
    });
    off();
    store.revoke(token);
    assert.equal(closed, 0);
  });

  it('sweep revokes + tears down idle (expired) sessions', () => {
    let t = 0;
    const store = new SessionStore(100, () => t);
    const { token } = store.mint('p');
    let closed = 0;
    store.onTeardown(token, () => {
      closed++;
    });
    t = 101;
    store.sweep();
    assert.equal(store.size, 0);
    assert.equal(closed, 1);
  });

  it('revokeAll drops every session', () => {
    const store = new SessionStore(1000);
    store.mint('a');
    store.mint('b');
    store.revokeAll();
    assert.equal(store.size, 0);
  });

  it('a throwing teardown does not block the others', () => {
    const store = new SessionStore(1000);
    const { token } = store.mint('p');
    let second = 0;
    store.onTeardown(token, () => {
      throw new Error('boom');
    });
    store.onTeardown(token, () => {
      second++;
    });
    store.revoke(token); // must not throw
    assert.equal(second, 1);
  });
});

describe('bearerToken', () => {
  it('extracts the token (case-insensitive scheme)', () => {
    assert.equal(bearerToken('Bearer abc.def'), 'abc.def');
    assert.equal(bearerToken('bearer xyz'), 'xyz');
  });
  it('returns null for missing / malformed headers', () => {
    assert.equal(bearerToken(undefined), null);
    assert.equal(bearerToken('Basic abc'), null);
    assert.equal(bearerToken('Bearer '), null);
    assert.equal(bearerToken('Bearer    '), null);
  });
});

describe('isPublicPath', () => {
  it('allows GET /status and POST /auth/login (ignoring query)', () => {
    assert.equal(isPublicPath('GET', '/status'), true);
    assert.equal(isPublicPath('GET', '/status?x=1'), true);
    assert.equal(isPublicPath('POST', '/auth/login'), true);
  });
  it('rejects everything else', () => {
    assert.equal(isPublicPath('POST', '/status'), false);
    assert.equal(isPublicPath('GET', '/auth/login'), false);
    assert.equal(isPublicPath('GET', '/notes'), false);
    assert.equal(isPublicPath('GET', '/auth/session'), false);
  });
});
