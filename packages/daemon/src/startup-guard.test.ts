/**
 * Phase A (A0) — daemon startup-guard tests.
 *
 * Pure config-validation gate; the resolved AI key is injected so the suite
 * never touches disk / network. Mirrors design §3.3 (6 guards).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, type OwlConfig } from '@owl/core';
import { DaemonStartupError, assertDaemonStartupSafe } from './startup-guard.js';

/** A valid 32-lowercase-hex profileId for account_lock tests. */
const OWNER = '0123456789abcdef0123456789abcdef';

/** Build an OwlConfig with daemon-section overrides. */
function cfg(daemon: Partial<OwlConfig['daemon']>): OwlConfig {
  return { ...DEFAULT_CONFIG, daemon: { ...DEFAULT_CONFIG.daemon, ...daemon } };
}

function check(daemon: Partial<OwlConfig['daemon']>, resolvedApiKey = ''): void {
  assertDaemonStartupSafe(cfg(daemon), { resolvedApiKey });
}

describe('assertDaemonStartupSafe — local (default, zero behaviour change)', () => {
  it('accepts the default config (mode=local, bind=127.0.0.1)', () => {
    assert.doesNotThrow(() => check({}));
  });

  it('accepts local + ::1 / localhost loopback binds', () => {
    assert.doesNotThrow(() => check({ bind: '::1' }));
    assert.doesNotThrow(() => check({ bind: 'localhost' }));
  });

  it('refuses local + non-loopback bind (red line: 0.0.0.0 without auth)', () => {
    assert.throws(() => check({ bind: '0.0.0.0' }), DaemonStartupError);
    assert.throws(() => check({ bind: '0.0.0.0' }), /requires mode='cloud'/);
  });
});

describe('assertDaemonStartupSafe — ⑥ field validation', () => {
  it('refuses an invalid mode', () => {
    assert.throws(() => check({ mode: 'sideways' as 'local' }), /\[daemon\]\.mode/);
  });

  it('refuses an empty bind', () => {
    assert.throws(() => check({ bind: '' }), /\[daemon\]\.bind/);
  });

  it('refuses a non-positive session_ttl_min', () => {
    assert.throws(
      () =>
        check({
          mode: 'cloud',
          server_url: 'http://x:1',
          account_lock: 'off',
          public_url: 'http://x:1',
          session_ttl_min: 0,
        }),
      /session_ttl_min/,
    );
  });
});

describe('assertDaemonStartupSafe — cloud guards', () => {
  const base = {
    mode: 'cloud' as const,
    server_url: 'http://127.0.0.1:18443',
    public_url: 'http://127.0.0.1:47010',
  };

  it('refuses cloud without server_url (guard 2)', () => {
    assert.throws(
      () => check({ mode: 'cloud', account_lock: 'off', public_url: 'http://x:1' }),
      /server_url/,
    );
  });

  it('refuses cloud with an unparseable server_url', () => {
    assert.throws(
      () => check({ ...base, account_lock: OWNER, server_url: 'not-a-url' }),
      /server_url/,
    );
  });

  it('refuses cloud without account_lock (① fail-closed)', () => {
    assert.throws(() => check({ ...base }), DaemonStartupError);
    assert.throws(() => check({ ...base }), /account_lock/);
  });

  it('refuses an account_lock that is neither "off" nor a 32-hex profileId', () => {
    assert.throws(() => check({ ...base, account_lock: 'nope' }), /32-hex profileId/);
  });

  it('refuses off + a server-side AI key (⑤ burn risk)', () => {
    assert.throws(
      () => check({ ...base, account_lock: 'off' }, 'sk-real-key'),
      /must not hold a server-side AI key/,
    );
  });

  it('accepts off + empty AI key', () => {
    assert.doesNotThrow(() => check({ ...base, account_lock: 'off' }, ''));
  });

  it('refuses cloud without public_url and without allowed_hosts (②, any bind)', () => {
    assert.throws(
      () => check({ mode: 'cloud', server_url: 'http://x:1', account_lock: OWNER }),
      /public_url or \[daemon\]\.allowed_hosts/,
    );
  });

  it('accepts cloud with allowed_hosts but no public_url', () => {
    assert.doesNotThrow(() =>
      check({
        mode: 'cloud',
        server_url: 'http://x:1',
        account_lock: OWNER,
        allowed_hosts: ['owl.example.com'],
      }),
    );
  });

  it('accepts a fully-specified locked cloud config', () => {
    assert.doesNotThrow(() => check({ ...base, account_lock: OWNER }));
  });

  it('refuses an unparseable public_url', () => {
    assert.throws(
      () => check({ ...base, account_lock: OWNER, public_url: 'localhost-no-scheme' }),
      /public_url/,
    );
  });

  it('refuses an unparseable allowed_origins entry', () => {
    assert.throws(
      () =>
        check({ ...base, account_lock: OWNER, allowed_origins: ['https://ok.example', 'garbage'] }),
      /allowed_origins/,
    );
  });

  it('refuses an allowed_hosts entry that is a URL, not a host', () => {
    assert.throws(
      () =>
        check({
          mode: 'cloud',
          server_url: 'http://x:1',
          account_lock: OWNER,
          allowed_hosts: ['https://owl.example.com/'],
        }),
      /allowed_hosts/,
    );
  });

  it('accepts host[:port] / IP / bracketed-IPv6 allowed_hosts', () => {
    assert.doesNotThrow(() =>
      check({
        mode: 'cloud',
        server_url: 'http://x:1',
        account_lock: OWNER,
        allowed_hosts: ['owl.example.com', '192.168.1.10:8443', '[::1]', 'localhost'],
      }),
    );
  });
});
