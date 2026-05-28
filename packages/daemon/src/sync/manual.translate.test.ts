/**
 * P5-d Phase 10 — `translateSkybridgeError` translation matrix.
 *
 * After retiring the daemon plaintext bootstrap, the function no
 * longer takes a `configPath` and no longer side-effects on 401
 * (clearSkybridgeAuth call gone). This file pins the post-retirement
 * shape:
 *  - SDK NetworkError → SkybridgeServerUnreachableError
 *  - SDK ApiError(401) → SkybridgeAuthRequiredError (NO toml side effect)
 *  - SDK ApiError(other) → SkybridgeApiError(status)
 *  - core errors (SkybridgeNotConfigured etc.) pass through
 *  - plain Error → SkybridgeSyncFailedError
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SkybridgeAuthRequiredError,
  SkybridgeNotConfiguredError,
  SkybridgeServerUrlMissingError,
} from '@owl/core';
import {
  SkybridgeApiError,
  SkybridgeNotInstalledError,
  SkybridgeServerUnreachableError,
  SkybridgeSyncFailedError,
  translateSkybridgeError,
} from './manual.js';

// Duck-typed mocks of the SDK's NetworkError / ApiError. The
// manual.ts isNetworkError / isApiError helpers narrow by `name` and
// `status`, so a plain Object.assign(new Error, {...}) is enough.

function fakeNetworkError(message: string): Error {
  return Object.assign(new Error(message), { name: 'NetworkError' });
}

function fakeApiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { name: 'ApiError', status });
}

describe('translateSkybridgeError — Phase 10 (no configPath, no toml side effect)', () => {
  it('NetworkError → SkybridgeServerUnreachableError, preserves message', () => {
    const translated = translateSkybridgeError(fakeNetworkError('ECONNREFUSED'));
    assert.ok(translated instanceof SkybridgeServerUnreachableError);
    assert.match(translated.message, /unreachable.*ECONNREFUSED/);
  });

  it('ApiError(401) → SkybridgeAuthRequiredError with Chinese hint', () => {
    const translated = translateSkybridgeError(fakeApiError(401, 'token revoked'));
    assert.ok(translated instanceof SkybridgeAuthRequiredError);
    assert.match(translated.message, /请在设置中重新登录/);
  });

  it('ApiError(500) → SkybridgeApiError carrying the original status', () => {
    const translated = translateSkybridgeError(fakeApiError(500, 'server boom'));
    assert.ok(translated instanceof SkybridgeApiError);
    assert.equal((translated as SkybridgeApiError).status, 500);
  });

  it('ApiError(403) → SkybridgeApiError(403)', () => {
    const translated = translateSkybridgeError(fakeApiError(403, 'forbidden'));
    assert.ok(translated instanceof SkybridgeApiError);
    assert.equal((translated as SkybridgeApiError).status, 403);
  });

  it('passes through SkybridgeNotConfiguredError unchanged', () => {
    const e = new SkybridgeNotConfiguredError('/tmp/nope.toml');
    const translated = translateSkybridgeError(e);
    assert.equal(translated, e, 'same reference');
  });

  it('passes through SkybridgeServerUrlMissingError unchanged', () => {
    const e = new SkybridgeServerUrlMissingError('/tmp/missing.toml');
    const translated = translateSkybridgeError(e);
    assert.equal(translated, e);
  });

  it('passes through SkybridgeAuthRequiredError unchanged (no double-wrap)', () => {
    const e = new SkybridgeAuthRequiredError('original');
    const translated = translateSkybridgeError(e);
    assert.equal(translated, e);
  });

  it('passes through SkybridgeNotInstalledError unchanged', () => {
    const e = new SkybridgeNotInstalledError(new Error('module missing'));
    const translated = translateSkybridgeError(e);
    assert.equal(translated, e);
  });

  it('plain Error → SkybridgeSyncFailedError', () => {
    const translated = translateSkybridgeError(new Error('something else'));
    assert.ok(translated instanceof SkybridgeSyncFailedError);
    assert.match(translated.message, /something else/);
  });

  it('non-Error throw (string) → SkybridgeSyncFailedError', () => {
    const translated = translateSkybridgeError('weird string');
    assert.ok(translated instanceof SkybridgeSyncFailedError);
  });
});
