/**
 * Phase A (A1) — CORS origin allowlist + Host header check tests.
 *
 * Pure functions; mirror design §4.1 across local + cloud modes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, type OwlConfig } from '@owl/core';
import { hostnameFromHostHeader, isHostAllowed, isOriginAllowed } from './access-guard.js';

function cfg(daemon: Partial<OwlConfig['daemon']>): OwlConfig {
  return { ...DEFAULT_CONFIG, daemon: { ...DEFAULT_CONFIG.daemon, ...daemon } };
}

const LOCAL = cfg({}); // mode='local', bind='127.0.0.1'
const CLOUD = cfg({
  mode: 'cloud',
  server_url: 'http://127.0.0.1:18443',
  account_lock: 'off',
  public_url: 'https://owl.example.com',
  allowed_origins: ['https://app.example.com'],
  allowed_hosts: ['owl.example.com', '192.168.1.10:8443'],
});

describe('hostnameFromHostHeader', () => {
  it('strips the port', () => {
    assert.equal(hostnameFromHostHeader('127.0.0.1:47010'), '127.0.0.1');
    assert.equal(hostnameFromHostHeader('owl.example.com'), 'owl.example.com');
  });
  it('preserves a bracketed IPv6 literal', () => {
    assert.equal(hostnameFromHostHeader('[::1]:47010'), '[::1]');
    assert.equal(hostnameFromHostHeader('[::1]'), '[::1]');
  });
});

describe('isOriginAllowed — local mode', () => {
  it('allows no Origin (CLI / same-origin / curl)', () => {
    assert.equal(isOriginAllowed(LOCAL, undefined), true);
  });
  it("allows Electron prod 'null' origin", () => {
    assert.equal(isOriginAllowed(LOCAL, 'null'), true);
  });
  it('allows loopback http origins (vite dev / localhost browser)', () => {
    assert.equal(isOriginAllowed(LOCAL, 'http://localhost:5173'), true);
    assert.equal(isOriginAllowed(LOCAL, 'http://127.0.0.1:47010'), true);
    assert.equal(isOriginAllowed(LOCAL, 'http://[::1]:8080'), true);
  });
  it('rejects external origins', () => {
    assert.equal(isOriginAllowed(LOCAL, 'https://evil.example.com'), false);
    assert.equal(isOriginAllowed(LOCAL, 'http://example.com'), false);
  });
});

describe('isOriginAllowed — cloud mode', () => {
  it('allows no Origin', () => {
    assert.equal(isOriginAllowed(CLOUD, undefined), true);
  });
  it('allows the public_url origin + allowed_origins', () => {
    assert.equal(isOriginAllowed(CLOUD, 'https://owl.example.com'), true);
    assert.equal(isOriginAllowed(CLOUD, 'https://app.example.com'), true);
  });
  it("rejects 'null' and loopback and external origins in cloud", () => {
    assert.equal(isOriginAllowed(CLOUD, 'null'), false);
    assert.equal(isOriginAllowed(CLOUD, 'http://localhost:5173'), false);
    assert.equal(isOriginAllowed(CLOUD, 'https://evil.example.com'), false);
  });
});

describe('isHostAllowed — local mode', () => {
  it('allows loopback hosts with any port', () => {
    assert.equal(isHostAllowed(LOCAL, '127.0.0.1:47010'), true);
    assert.equal(isHostAllowed(LOCAL, 'localhost:80'), true);
    assert.equal(isHostAllowed(LOCAL, '[::1]:47010'), true);
  });
  it('rejects a non-loopback (spoofed) Host', () => {
    assert.equal(isHostAllowed(LOCAL, 'evil.example.com'), false);
    assert.equal(isHostAllowed(LOCAL, 'owl.example.com:443'), false);
  });
  it('rejects a missing Host header', () => {
    assert.equal(isHostAllowed(LOCAL, undefined), false);
  });
});

describe('isHostAllowed — cloud mode', () => {
  it('allows loopback (same-machine / local sim)', () => {
    assert.equal(isHostAllowed(CLOUD, '127.0.0.1:47010'), true);
  });
  it('allows the public_url host (reverse proxy)', () => {
    assert.equal(isHostAllowed(CLOUD, 'owl.example.com'), true);
    assert.equal(isHostAllowed(CLOUD, 'owl.example.com:443'), true);
  });
  it('allows an allowed_hosts entry (incl host:port exact)', () => {
    assert.equal(isHostAllowed(CLOUD, '192.168.1.10:8443'), true);
    assert.equal(isHostAllowed(CLOUD, '192.168.1.10'), true);
  });
  it('rejects an unknown host', () => {
    assert.equal(isHostAllowed(CLOUD, 'evil.example.com'), false);
  });
});
