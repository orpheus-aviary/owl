/**
 * Unit suite for `packages/core/src/profile/resolver.ts` (P5-d Phase 12/13).
 *
 * Uses a per-test temp nest via `OWL_NEST_DIR`; never touches the real
 * `~/orpheus-aviary-nest/`. Phase 13 remaps the local profile onto
 * `owl/owl.db` (D10a) and adds the unified `resolveActiveProfile` three-way
 * gate, but stays behavior-preserving: with no live profile db on disk the
 * resolver still falls back to legacy `dbPath()`.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  dbPath,
  localProfileDbPath,
  profileDbPath,
  profilesDir,
  skybridgeConfigPath,
} from '../config/paths.js';
import {
  isHexProfileId,
  isValidProfileId,
  readActiveProfileId,
  resolveActiveProfile,
  resolveActiveProfileDbPath,
} from './resolver.js';

const VALID_ID = 'a'.repeat(32);
const OTHER_ID = 'b'.repeat(32);
const originalNestDir = process.env.OWL_NEST_DIR;
let nest: string;

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'owl-profile-resolver-'));
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

function writeSkybridge(contents: string, path = skybridgeConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function touchDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}

/** A v2 toml that activates `id` and (optionally) carries its section. */
function v2(id: string, opts: { section?: boolean; url?: string } = {}): string {
  const { section = true, url = 'http://x:8443' } = opts;
  let out = `active_profile = "${id}"\n`;
  if (section) out += `\n[profiles.${id}]\nserver_url = "${url}"\n`;
  return out;
}

describe('paths profile helpers (Phase 13 — D10a remap)', () => {
  it('localProfileDbPath() === dbPath() (local lives in place at owl/owl.db)', () => {
    assert.equal(localProfileDbPath(), dbPath());
    assert.equal(localProfileDbPath(), join(nest, 'owl', 'owl.db'));
  });

  it('profileDbPath / profilesDir unchanged', () => {
    assert.equal(profilesDir(), join(nest, 'owl', 'profiles'));
    assert.equal(profileDbPath(VALID_ID), join(nest, 'owl', 'profiles', VALID_ID, 'owl.db'));
  });
});

describe('readActiveProfileId (Phase 12/13)', () => {
  it('null when no config file', () => {
    assert.equal(readActiveProfileId(), null);
  });

  it('null when active_profile absent', () => {
    writeSkybridge('[server]\nurl = "http://x:8443"\n');
    assert.equal(readActiveProfileId(), null);
  });

  it('reads active_profile string', () => {
    writeSkybridge(`active_profile = "${VALID_ID}"\n`);
    assert.equal(readActiveProfileId(), VALID_ID);
  });

  it('null on malformed toml (never throws)', () => {
    writeSkybridge('active_profile = =bad');
    assert.equal(readActiveProfileId(), null);
  });

  it('reads from an explicit path (Phase 13 P2)', () => {
    const custom = join(nest, 'custom.toml');
    writeSkybridge(`active_profile = "${OTHER_ID}"\n`, custom);
    assert.equal(readActiveProfileId(custom), OTHER_ID);
    // The default path is untouched → null, proving isolation.
    assert.equal(readActiveProfileId(), null);
  });
});

describe('isValidProfileId / isHexProfileId (Phase 12/13)', () => {
  it('isValidProfileId accepts reserved local + 32 lowercase hex', () => {
    assert.ok(isValidProfileId('local'));
    assert.ok(isValidProfileId(VALID_ID));
  });

  it('isValidProfileId rejects path-escape / wrong length / non-hex / empty', () => {
    assert.ok(!isValidProfileId('../etc'));
    assert.ok(!isValidProfileId('local/../x'));
    assert.ok(!isValidProfileId('a'.repeat(16)));
    assert.ok(!isValidProfileId('A'.repeat(32)));
    assert.ok(!isValidProfileId(''));
  });

  it('isHexProfileId is hex-only — rejects local', () => {
    assert.ok(isHexProfileId(VALID_ID));
    assert.ok(!isHexProfileId('local'));
    assert.ok(!isHexProfileId('A'.repeat(32)));
    assert.ok(!isHexProfileId(''));
  });
});

describe('resolveActiveProfile (Phase 13 — three-way gate)', () => {
  it('null when no config', () => {
    assert.equal(resolveActiveProfile(), null);
  });

  it('null when active=local (local is not a hex profile)', () => {
    writeSkybridge('active_profile = "local"\n');
    assert.equal(resolveActiveProfile(), null);
  });

  it('null when active id invalid (path-escape guard)', () => {
    writeSkybridge('active_profile = "../../etc/passwd"\n');
    assert.equal(resolveActiveProfile(), null);
  });

  it('null when section present but db missing (gate ③)', () => {
    writeSkybridge(v2(VALID_ID));
    assert.equal(resolveActiveProfile(), null);
  });

  it('null when db present but [profiles.<id>] section missing (reverse split-brain, gate ②)', () => {
    writeSkybridge(v2(VALID_ID, { section: false }));
    touchDb(profileDbPath(VALID_ID));
    assert.equal(resolveActiveProfile(), null);
  });

  it('resolves {id, dbPath} when id valid AND section present AND db exists', () => {
    writeSkybridge(v2(VALID_ID));
    touchDb(profileDbPath(VALID_ID));
    assert.deepEqual(resolveActiveProfile(), {
      id: VALID_ID,
      dbPath: profileDbPath(VALID_ID),
    });
  });

  it('reads from an explicit path, isolated from the default (P2)', () => {
    const custom = join(nest, 'custom.toml');
    writeSkybridge(v2(VALID_ID), custom);
    touchDb(profileDbPath(VALID_ID));
    assert.deepEqual(resolveActiveProfile(custom), {
      id: VALID_ID,
      dbPath: profileDbPath(VALID_ID),
    });
    // Default path has no config → null.
    assert.equal(resolveActiveProfile(), null);
  });
});

describe('resolveActiveProfileDbPath (Phase 13, behavior-preserving)', () => {
  it('legacy dbPath() when no config', () => {
    assert.equal(resolveActiveProfileDbPath(), dbPath());
  });

  it('legacy when no active_profile', () => {
    writeSkybridge('[server]\nurl = "http://x:8443"\n');
    assert.equal(resolveActiveProfileDbPath(), dbPath());
  });

  it('legacy when active=local (now resolves to owl/owl.db = local in place)', () => {
    writeSkybridge('active_profile = "local"\n');
    assert.equal(resolveActiveProfileDbPath(), dbPath());
  });

  it('legacy when active set but profile db missing (existence gate ③)', () => {
    writeSkybridge(v2(VALID_ID));
    assert.equal(resolveActiveProfileDbPath(), dbPath());
  });

  it('legacy when db present but section missing (gate ② sync with adapter)', () => {
    writeSkybridge(v2(VALID_ID, { section: false }));
    touchDb(profileDbPath(VALID_ID));
    assert.equal(resolveActiveProfileDbPath(), dbPath());
  });

  it('legacy when active id invalid (path-escape guard)', () => {
    writeSkybridge('active_profile = "../../etc/passwd"\n');
    assert.equal(resolveActiveProfileDbPath(), dbPath());
  });

  it('profile path when active valid AND section AND db exist', () => {
    writeSkybridge(v2(VALID_ID));
    touchDb(profileDbPath(VALID_ID));
    assert.equal(resolveActiveProfileDbPath(), profileDbPath(VALID_ID));
  });
});
