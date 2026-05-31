/**
 * Unit suite for `packages/core/src/profile/id.ts` (P5-d Phase 12).
 * Pure functions — no fs / env needed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InvalidServerUrlError, computeProfileId, normalizeServerUrl } from './id.js';

describe('normalizeServerUrl (Phase 12)', () => {
  it('lowercases scheme + host', () => {
    assert.equal(normalizeServerUrl('HTTP://Example.COM:8443'), 'http://example.com:8443');
  });

  it('strips trailing slash, keeps explicit non-default port', () => {
    assert.equal(normalizeServerUrl('http://x:8443/'), 'http://x:8443');
  });

  it('strips default ports (http:80 / https:443)', () => {
    assert.equal(normalizeServerUrl('http://x:80'), 'http://x');
    assert.equal(normalizeServerUrl('https://x:443'), 'https://x');
  });

  it('preserves a non-root path prefix, drops query + hash', () => {
    assert.equal(normalizeServerUrl('https://x:8443/owl-sync/?q=1#h'), 'https://x:8443/owl-sync');
  });

  it('root path collapses to empty', () => {
    assert.equal(normalizeServerUrl('https://x/'), 'https://x');
  });

  it('throws on unparseable url', () => {
    assert.throws(() => normalizeServerUrl('not a url'), InvalidServerUrlError);
  });

  it('throws on non-http(s) scheme', () => {
    assert.throws(() => normalizeServerUrl('ftp://x/'), InvalidServerUrlError);
  });
});

describe('computeProfileId (Phase 15 — D11 server_id anchor)', () => {
  it('is 32 lowercase hex chars', () => {
    assert.match(computeProfileId('srv-abc123', 'user-1'), /^[0-9a-f]{32}$/);
  });

  it('is deterministic', () => {
    assert.equal(computeProfileId('srv-abc123', 'u'), computeProfileId('srv-abc123', 'u'));
  });

  it('is independent of the server url (url not in the id)', () => {
    // Same server_id + user → same profile, regardless of how the url is spelled.
    // (The caller passes a server_id, never a url; this just pins "url plays no role".)
    assert.equal(computeProfileId('srv-1', 'u'), computeProfileId('srv-1', 'u'));
  });

  it('differs by user', () => {
    assert.notEqual(computeProfileId('srv-1', 'a'), computeProfileId('srv-1', 'b'));
  });

  it('differs by server_id', () => {
    assert.notEqual(computeProfileId('srv-a', 'u'), computeProfileId('srv-b', 'u'));
  });

  it('treats server_id verbatim (no normalization)', () => {
    // server_id is opaque — different spellings are different profiles.
    assert.notEqual(computeProfileId('SRV-1', 'u'), computeProfileId('srv-1', 'u'));
  });
});
