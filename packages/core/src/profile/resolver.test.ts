/**
 * Unit suite for `packages/core/src/profile/resolver.ts` (P5-d Phase 12).
 *
 * Uses a per-test temp nest via `OWL_NEST_DIR`; never touches the real
 * `~/orpheus-aviary-nest/`. Phase 12 is behavior-preserving, so the headline
 * assertions are "resolves to legacy dbPath()" until a profile db exists.
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
import { isValidProfileId, readActiveProfileId, resolveActiveProfileDbPath } from './resolver.js';

const VALID_ID = 'a'.repeat(32);
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

function writeSkybridge(contents: string): void {
  const p = skybridgeConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, contents);
}

function touchDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
}

describe('paths profile helpers (Phase 12)', () => {
  it('nests profiles dir under owlDir', () => {
    assert.equal(profilesDir(), join(nest, 'owl', 'profiles'));
    assert.equal(profileDbPath(VALID_ID), join(nest, 'owl', 'profiles', VALID_ID, 'owl.db'));
    assert.equal(localProfileDbPath(), join(nest, 'owl', 'profiles', 'local', 'owl.db'));
  });
});

describe('readActiveProfileId (Phase 12)', () => {
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
});

describe('isValidProfileId (Phase 12)', () => {
  it('accepts reserved local + 32 lowercase hex', () => {
    assert.ok(isValidProfileId('local'));
    assert.ok(isValidProfileId(VALID_ID));
  });

  it('rejects path-escape / wrong length / non-hex / empty', () => {
    assert.ok(!isValidProfileId('../etc'));
    assert.ok(!isValidProfileId('local/../x'));
    assert.ok(!isValidProfileId('a'.repeat(16)));
    assert.ok(!isValidProfileId('A'.repeat(32)));
    assert.ok(!isValidProfileId(''));
  });
});

describe('resolveActiveProfileDbPath (Phase 12, behavior-preserving)', () => {
  it('legacy when no config', () => {
    assert.equal(resolveActiveProfileDbPath(), dbPath());
  });

  it('legacy when no active_profile', () => {
    writeSkybridge('[server]\nurl = "http://x:8443"\n');
    assert.equal(resolveActiveProfileDbPath(), dbPath());
  });

  it('legacy when active_profile set but profile db missing (existence gate)', () => {
    writeSkybridge(`active_profile = "${VALID_ID}"\n`);
    assert.equal(resolveActiveProfileDbPath(), dbPath());
  });

  it('legacy when active_profile invalid (path-escape guard)', () => {
    writeSkybridge('active_profile = "../../etc/passwd"\n');
    assert.equal(resolveActiveProfileDbPath(), dbPath());
  });

  it('profile path when active_profile valid AND db exists', () => {
    writeSkybridge(`active_profile = "${VALID_ID}"\n`);
    touchDb(profileDbPath(VALID_ID));
    assert.equal(resolveActiveProfileDbPath(), profileDbPath(VALID_ID));
  });

  it('local profile path when active=local AND db exists', () => {
    writeSkybridge('active_profile = "local"\n');
    touchDb(localProfileDbPath());
    assert.equal(resolveActiveProfileDbPath(), localProfileDbPath());
  });
});
