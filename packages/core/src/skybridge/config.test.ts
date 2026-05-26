/**
 * Unit suite for `packages/core/src/skybridge/config.ts` (P5-a Step 6).
 *
 * Uses a per-test temp dir; never touches the real
 * `~/orpheus-aviary-nest/skybridge/`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  SkybridgeAuthRequiredError,
  type SkybridgeConfig,
  SkybridgeNotConfiguredError,
  SkybridgeServerUrlMissingError,
  clearSkybridgeAuth,
  readSkybridgeConfig,
  removeSkybridgeConfig,
  requireAuth,
  writeSkybridgeConfig,
} from './config.js';

const SERVER_URL = 'http://127.0.0.1:18443';

let tmp: string;
let cfgPath: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sky-cfg-'));
  cfgPath = join(tmp, 'skybridge_config.toml');
});

beforeEach(() => {
  removeSkybridgeConfig(cfgPath);
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── error surface ──────────────────────────────────────

describe('readSkybridgeConfig — error surface', () => {
  it('missing file → SkybridgeNotConfiguredError (code SKYBRIDGE_NOT_CONFIGURED)', () => {
    try {
      readSkybridgeConfig(cfgPath);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof SkybridgeNotConfiguredError);
      assert.equal(err.code, 'SKYBRIDGE_NOT_CONFIGURED');
      assert.equal(err.path, cfgPath);
    }
  });

  it('file present but [server].url missing → SkybridgeServerUrlMissingError', () => {
    writeFileSync(cfgPath, '[server]\n# no url\n', 'utf-8');
    try {
      readSkybridgeConfig(cfgPath);
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof SkybridgeServerUrlMissingError);
      assert.equal(err.code, 'SKYBRIDGE_SERVER_URL_MISSING');
    }
  });

  it('[server].url empty string → SkybridgeServerUrlMissingError', () => {
    writeFileSync(cfgPath, '[server]\nurl = ""\n', 'utf-8');
    assert.throws(() => readSkybridgeConfig(cfgPath), SkybridgeServerUrlMissingError);
  });
});

// ─── round-trip ─────────────────────────────────────────

describe('writeSkybridgeConfig + readSkybridgeConfig — round-trip', () => {
  it('server-only config round-trips with auth/device/workspace undefined', () => {
    const cfg: SkybridgeConfig = { server: { url: SERVER_URL } };
    writeSkybridgeConfig(cfg, cfgPath);
    const back = readSkybridgeConfig(cfgPath);
    assert.deepEqual(back, { server: { url: SERVER_URL } });
    assert.equal(back.auth, undefined);
    assert.equal(back.device, undefined);
    assert.equal(back.workspace, undefined);
  });

  it('full config round-trips all four sections', () => {
    const cfg: SkybridgeConfig = {
      server: { url: SERVER_URL },
      auth: { user_id: 'usr_1', token: 'tok_1', email: 'jay@local' },
      device: {
        id: 'dev_1',
        name: "Jay's MacBook (owl)",
        app_version: 'owl 0.5.0-dev',
        client_version: '0.1.0',
      },
      workspace: { id: 'ws_1', slug: 'owl/default' },
    };
    writeSkybridgeConfig(cfg, cfgPath);
    const back = readSkybridgeConfig(cfgPath);
    assert.deepEqual(back, cfg);
  });

  it('file is chmod 600 after write (POSIX-only check)', () => {
    if (process.platform === 'win32') return;
    writeSkybridgeConfig({ server: { url: SERVER_URL } }, cfgPath);
    const mode = statSync(cfgPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('writing creates the parent dir if missing', () => {
    const nested = join(tmp, 'deeper', 'sk.toml');
    writeSkybridgeConfig({ server: { url: SERVER_URL } }, nested);
    const back = readSkybridgeConfig(nested);
    assert.equal(back.server.url, SERVER_URL);
  });

  it('write overwrites — second call wins, no merge', () => {
    writeSkybridgeConfig(
      {
        server: { url: SERVER_URL },
        auth: { user_id: 'u1', token: 't1', email: 'a@b' },
      },
      cfgPath,
    );
    writeSkybridgeConfig({ server: { url: 'http://2' } }, cfgPath);
    const back = readSkybridgeConfig(cfgPath);
    assert.equal(back.server.url, 'http://2');
    assert.equal(back.auth, undefined);
  });
});

// ─── partial auth → ignored ─────────────────────────────

describe('readSkybridgeConfig — partial auth section', () => {
  it('auth without token is dropped (no half-state)', () => {
    writeFileSync(
      cfgPath,
      `[server]\nurl = "${SERVER_URL}"\n\n[auth]\nuser_id = "x"\nemail = "y@z"\n`,
      'utf-8',
    );
    const back = readSkybridgeConfig(cfgPath);
    assert.equal(back.auth, undefined);
  });
});

// ─── requireAuth ────────────────────────────────────────

describe('requireAuth narrowing', () => {
  it('returns the same config when auth is present', () => {
    const cfg: SkybridgeConfig = {
      server: { url: SERVER_URL },
      auth: { user_id: 'u', token: 't', email: 'e' },
    };
    const narrowed = requireAuth(cfg);
    assert.equal(narrowed.auth.token, 't');
  });

  it('throws SkybridgeAuthRequiredError when auth is absent', () => {
    assert.throws(
      () => requireAuth({ server: { url: SERVER_URL } }),
      (err: unknown) =>
        err instanceof SkybridgeAuthRequiredError &&
        (err as SkybridgeAuthRequiredError & { code: string }).code === 'SKYBRIDGE_AUTH_REQUIRED',
    );
  });

  // P5-d Phase 7 — encrypted-only toml must NOT pass the daemon's
  // authenticated narrow. Daemon has no Electron handle, so the
  // ciphertext is unusable from there; GUI main → /sync/session is the
  // only path that can land the plaintext token in ctx.
  it('throws SkybridgeAuthRequiredError when only encrypted_token is present (no plaintext)', () => {
    const cfg: SkybridgeConfig = {
      server: { url: SERVER_URL },
      auth: { user_id: 'u', email: 'e', encrypted_token: 'base64ciphertext' },
    };
    assert.throws(
      () => requireAuth(cfg),
      (err: unknown) =>
        err instanceof SkybridgeAuthRequiredError &&
        (err as SkybridgeAuthRequiredError & { code: string }).code === 'SKYBRIDGE_AUTH_REQUIRED',
    );
  });
});

// ─── encrypted_token round-trip (P5-d Phase 7) ──────────

describe('readSkybridgeConfig — encrypted_token transitional schema', () => {
  it('populates auth from a toml that has encrypted_token only (no plaintext token)', () => {
    const cfg: SkybridgeConfig = {
      server: { url: SERVER_URL },
      auth: { user_id: 'u', email: 'e', encrypted_token: 'ciphertext-b64' },
    };
    writeSkybridgeConfig(cfg, cfgPath);
    const back = readSkybridgeConfig(cfgPath);
    assert.equal(back.auth?.user_id, 'u');
    assert.equal(back.auth?.email, 'e');
    assert.equal(back.auth?.encrypted_token, 'ciphertext-b64');
    assert.equal(back.auth?.token, undefined, 'no plaintext token leaked into auth');
  });

  it('preserves both fields when toml carries plaintext + ciphertext (mid-transition)', () => {
    const cfg: SkybridgeConfig = {
      server: { url: SERVER_URL },
      auth: {
        user_id: 'u',
        email: 'e',
        token: 'legacy-plaintext',
        encrypted_token: 'ciphertext-b64',
      },
    };
    writeSkybridgeConfig(cfg, cfgPath);
    const back = readSkybridgeConfig(cfgPath);
    assert.equal(back.auth?.token, 'legacy-plaintext');
    assert.equal(back.auth?.encrypted_token, 'ciphertext-b64');
  });

  it('still populates auth from a legacy plaintext-only toml (no encrypted_token)', () => {
    const cfg: SkybridgeConfig = {
      server: { url: SERVER_URL },
      auth: { user_id: 'u', token: 'legacy-plaintext', email: 'e' },
    };
    writeSkybridgeConfig(cfg, cfgPath);
    const back = readSkybridgeConfig(cfgPath);
    assert.equal(back.auth?.token, 'legacy-plaintext');
    assert.equal(back.auth?.encrypted_token, undefined);
  });

  it('leaves auth undefined when user_id + email present but BOTH token fields absent', () => {
    // Hand-write toml to bypass the writer's shape constraint.
    const raw = `[server]\nurl = "${SERVER_URL}"\n\n[auth]\nuser_id = "u"\nemail = "e"\n`;
    writeFileSync(cfgPath, raw, 'utf-8');
    const back = readSkybridgeConfig(cfgPath);
    assert.equal(back.auth, undefined, 'no token of either kind → no auth');
  });
});

// ─── clearSkybridgeAuth ─────────────────────────────────

describe('clearSkybridgeAuth', () => {
  it('drops [auth] but keeps server/device/workspace', () => {
    const cfg: SkybridgeConfig = {
      server: { url: SERVER_URL },
      auth: { user_id: 'u', token: 't', email: 'e' },
      device: {
        id: 'dev_1',
        name: 'mb',
        app_version: 'owl 0.5.0',
        client_version: '0.1.0',
      },
      workspace: { id: 'ws_1', slug: 'owl/default' },
    };
    writeSkybridgeConfig(cfg, cfgPath);
    clearSkybridgeAuth(cfgPath);
    const back = readSkybridgeConfig(cfgPath);
    assert.equal(back.auth, undefined);
    assert.equal(back.device?.id, 'dev_1');
    assert.equal(back.workspace?.id, 'ws_1');
    // On-disk TOML should not contain a [auth] heading at all
    const raw = readFileSync(cfgPath, 'utf-8');
    assert.ok(!raw.includes('[auth]'), `expected no [auth] section, got:\n${raw}`);
  });

  it('no-op when file does not exist', () => {
    // Should not throw
    clearSkybridgeAuth(cfgPath);
  });
});

describe('writeSkybridgeConfig — file mode (P5-c §6.27 token chmod)', () => {
  it(
    'chmods the file to 0600 on unix (regression guard for config.ts:177)',
    { skip: process.platform === 'win32' },
    () => {
      writeSkybridgeConfig(
        {
          server: { url: SERVER_URL },
          auth: { user_id: 'u', token: 'secret-token', email: 'e' },
        },
        cfgPath,
      );
      const mode = statSync(cfgPath).mode & 0o777;
      assert.equal(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
    },
  );

  it(
    'overwrite keeps the mode at 0600 (regression — partial write must not loosen perms)',
    { skip: process.platform === 'win32' },
    () => {
      // First write — establish baseline mode.
      writeSkybridgeConfig({ server: { url: SERVER_URL } }, cfgPath);
      assert.equal(statSync(cfgPath).mode & 0o777, 0o600);

      // Second full-file rewrite (e.g. login adds [auth] later).
      writeSkybridgeConfig(
        {
          server: { url: SERVER_URL },
          auth: { user_id: 'u', token: 'fresh-token', email: 'e' },
        },
        cfgPath,
      );
      assert.equal(
        statSync(cfgPath).mode & 0o777,
        0o600,
        'second writeSkybridgeConfig must re-apply 0600',
      );
    },
  );
});
