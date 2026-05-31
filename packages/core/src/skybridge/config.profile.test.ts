/**
 * P5-d Phase 13 — per-profile schema-v2 adapter + raw-preserve writers.
 *
 * These exercise the active-profile branch of `readSkybridgeConfig` and the
 * dormant v2 writers, so they need a real on-disk nest (the three-way gate
 * checks `profileDbPath(id)` existence). Isolated via `OWL_NEST_DIR`; the
 * toml + profile dbs all live inside the temp nest. Legacy-shape coverage
 * stays in `config.test.ts`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parse } from 'smol-toml';
import { profileDbPath, skybridgeConfigPath } from '../config/paths.js';
import { resolveActiveProfileDbPath } from '../profile/resolver.js';
import {
  InvalidProfileIdError,
  type ProfileConfigSection,
  ProfileDbMissingError,
  SkybridgeServerUrlMissingError,
  clearSkybridgeAuth,
  readSkybridgeConfig,
  removeProfile,
  setActiveProfile,
  writeProfileConfig,
} from './config.js';

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);
const URL_A = 'http://profile-a:8443';
const URL_B = 'http://profile-b:8443';
const LEGACY_URL = 'http://legacy:8443';

const originalNestDir = process.env.OWL_NEST_DIR;
let nest: string;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'owl-sky-profile-'));
  process.env.OWL_NEST_DIR = nest;
});

afterEach(() => {
  if (originalNestDir === undefined) {
    // biome-ignore lint/performance/noDelete: assigning undefined stringifies it to "undefined" in process.env; delete is the only way to truly unset
    delete process.env.OWL_NEST_DIR;
  } else {
    process.env.OWL_NEST_DIR = originalNestDir;
  }
  rmSync(nest, { recursive: true, force: true });
});

function writeToml(contents: string): void {
  const p = skybridgeConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, contents);
}

function touchDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}

function readRaw(): Record<string, unknown> {
  return parse(readFileSync(skybridgeConfigPath(), 'utf-8')) as Record<string, unknown>;
}

const sectionA: ProfileConfigSection = {
  server_url: URL_A,
  user_id: 'usr_a',
  email: 'a@local',
  encrypted_token: 'cipher-a',
  device: { id: 'dev_a', name: 'mb (owl)', app_version: 'owl 0.5.0-dev', client_version: '0.1.4' },
  workspace: { id: 'ws_a', slug: 'owl/default' },
};

// ─── adapter: read active-profile view ──────────────────

describe('readSkybridgeConfig — active-profile view (Phase 13)', () => {
  it('returns the profile view when id valid + section present + db exists', () => {
    touchDb(profileDbPath(ID_A));
    writeProfileConfig(ID_A, sectionA, { setActive: true });
    const cfg = readSkybridgeConfig();
    assert.equal(cfg.server.url, URL_A);
    assert.equal(cfg.auth?.user_id, 'usr_a');
    assert.equal(cfg.auth?.email, 'a@local');
    assert.equal(cfg.auth?.encrypted_token, 'cipher-a');
    assert.equal(cfg.auth?.token, undefined, 'no plaintext token leaked');
    assert.equal(cfg.device?.id, 'dev_a');
    assert.equal(cfg.workspace?.id, 'ws_a');
  });

  it('falls back to legacy view when active hex db is missing (P1a forward, sync with resolver)', () => {
    // active hex + section present, but no profile db on disk.
    writeToml(
      `active_profile = "${ID_A}"\n\n[server]\nurl = "${LEGACY_URL}"\n\n[profiles.${ID_A}]\nserver_url = "${URL_A}"\n`,
    );
    const cfg = readSkybridgeConfig();
    assert.equal(cfg.server.url, LEGACY_URL, 'reads legacy [server], not the profile url');
    assert.equal(resolveActiveProfileDbPath(), join(nest, 'owl', 'owl.db'), 'resolver also legacy');
  });

  it('falls back to legacy view when active=local', () => {
    writeToml(`active_profile = "local"\n\n[server]\nurl = "${LEGACY_URL}"\n`);
    assert.equal(readSkybridgeConfig().server.url, LEGACY_URL);
    assert.equal(resolveActiveProfileDbPath(), join(nest, 'owl', 'owl.db'));
  });

  it('reverse split-brain: db present but [profiles.<id>] section absent → both fall to legacy', () => {
    writeToml(`active_profile = "${ID_A}"\n\n[server]\nurl = "${LEGACY_URL}"\n`);
    touchDb(profileDbPath(ID_A)); // db exists, but no section
    assert.equal(readSkybridgeConfig().server.url, LEGACY_URL, 'adapter falls to legacy');
    assert.equal(
      resolveActiveProfileDbPath(),
      join(nest, 'owl', 'owl.db'),
      'resolver falls to legacy too (in sync)',
    );
  });

  it('throws SkybridgeServerUrlMissingError when active profile section has no server_url', () => {
    touchDb(profileDbPath(ID_A));
    writeToml(`active_profile = "${ID_A}"\n\n[profiles.${ID_A}]\nuser_id = "u"\n`);
    assert.throws(() => readSkybridgeConfig(), SkybridgeServerUrlMissingError);
  });
});

// ─── writers: validation ────────────────────────────────

describe('writeProfileConfig / setActiveProfile — id validation (Phase 13)', () => {
  it('writeProfileConfig rejects non-hex id', () => {
    assert.throws(
      () => writeProfileConfig('not-hex', { server_url: URL_A }),
      (e: unknown) => e instanceof InvalidProfileIdError,
    );
  });

  it('writeProfileConfig rejects reserved "local"', () => {
    assert.throws(
      () => writeProfileConfig('local', { server_url: URL_A }),
      (e: unknown) => e instanceof InvalidProfileIdError,
    );
  });

  it('writeProfileConfig({setActive}) refuses a profile whose db is missing', () => {
    assert.throws(
      () => writeProfileConfig(ID_A, { server_url: URL_A }, { setActive: true }),
      (e: unknown) => e instanceof ProfileDbMissingError,
    );
  });

  it('writeProfileConfig WITHOUT setActive does not require the db (just writes the section)', () => {
    writeProfileConfig(ID_A, { server_url: URL_A }); // no throw
    assert.equal(readRaw().active_profile, undefined);
  });

  it('setActiveProfile("local") always activates (no db check)', () => {
    setActiveProfile('local');
    assert.equal(readRaw().active_profile, 'local');
  });

  it('setActiveProfile(hex) refuses a missing db', () => {
    assert.throws(
      () => setActiveProfile(ID_A),
      (e: unknown) => e instanceof ProfileDbMissingError,
    );
  });

  it('setActiveProfile rejects an invalid id', () => {
    assert.throws(
      () => setActiveProfile('../x'),
      (e: unknown) => e instanceof InvalidProfileIdError,
    );
  });
});

// ─── writers: raw-preserve (P2b) ────────────────────────

describe('raw-preserve writers keep siblings + active_profile (Phase 13 P2b)', () => {
  function seedTwoProfiles(): void {
    touchDb(profileDbPath(ID_A));
    touchDb(profileDbPath(ID_B));
    writeProfileConfig(ID_A, sectionA, { setActive: true });
    writeProfileConfig(ID_B, {
      server_url: URL_B,
      user_id: 'usr_b',
      email: 'b@local',
      encrypted_token: 'cipher-b',
    });
  }

  it('clearSkybridgeAuth clears only the active profile auth; sibling + active_profile survive', () => {
    seedTwoProfiles();
    clearSkybridgeAuth();
    const raw = readRaw();
    assert.equal(raw.active_profile, ID_A, 'active pointer intact');
    const profiles = raw.profiles as Record<string, Record<string, unknown>>;
    // Active profile A: auth fields gone, non-auth fields kept.
    assert.equal(profiles[ID_A].encrypted_token, undefined);
    assert.equal(profiles[ID_A].user_id, undefined);
    assert.equal(profiles[ID_A].email, undefined);
    assert.equal(profiles[ID_A].server_url, URL_A, 'server_url survives');
    assert.ok(profiles[ID_A].device, 'device survives');
    // Sibling B: fully intact.
    assert.equal(profiles[ID_B].encrypted_token, 'cipher-b');
    assert.equal(profiles[ID_B].user_id, 'usr_b');
    assert.equal(profiles[ID_B].server_url, URL_B);
  });

  it('writeProfileConfig on one profile preserves the other', () => {
    seedTwoProfiles();
    writeProfileConfig(ID_B, {
      server_url: 'http://changed:8443',
      user_id: 'usr_b2',
      email: 'b2@local',
    });
    const profiles = readRaw().profiles as Record<string, Record<string, unknown>>;
    assert.equal(profiles[ID_A].server_url, URL_A, 'A untouched');
    assert.equal(profiles[ID_A].encrypted_token, 'cipher-a');
    assert.equal(profiles[ID_B].server_url, 'http://changed:8443', 'B replaced');
  });

  it('removeProfile of the active profile drops it, keeps sibling, repoints active to local', () => {
    seedTwoProfiles();
    removeProfile(ID_A);
    const raw = readRaw();
    assert.equal(raw.active_profile, 'local', 'active falls back to local');
    const profiles = raw.profiles as Record<string, unknown>;
    assert.equal(profiles[ID_A], undefined, 'A removed');
    assert.ok(profiles[ID_B], 'B survives');
  });

  it('removeProfile of a non-active profile leaves active_profile alone', () => {
    seedTwoProfiles();
    removeProfile(ID_B);
    const raw = readRaw();
    assert.equal(raw.active_profile, ID_A, 'active pointer untouched');
    assert.equal((raw.profiles as Record<string, unknown>)[ID_B], undefined);
  });
});

// ─── writers: round-trip + chmod ────────────────────────

describe('writeProfileConfig — round-trip + file mode (Phase 13)', () => {
  it('round-trips a full section through the adapter', () => {
    touchDb(profileDbPath(ID_A));
    writeProfileConfig(ID_A, sectionA, { setActive: true });
    const cfg = readSkybridgeConfig();
    assert.deepEqual(cfg, {
      server: { url: URL_A },
      auth: { user_id: 'usr_a', email: 'a@local', encrypted_token: 'cipher-a' },
      device: sectionA.device,
      workspace: sectionA.workspace,
    });
  });

  it('chmods the toml to 0600', { skip: process.platform === 'win32' }, () => {
    writeProfileConfig(ID_A, { server_url: URL_A });
    assert.equal(statSync(skybridgeConfigPath()).mode & 0o777, 0o600);
  });
});
