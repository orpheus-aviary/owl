import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  aviaryConfigPath,
  configPath,
  daemonLogPath,
  dbPath,
  logDir,
  nestDir,
  owlDir,
  owlLogPath,
  pidPath,
  syncDbPath,
} from './paths.js';

describe('paths.ts — OWL_NEST_DIR env override (Step 0a)', () => {
  const original = process.env.OWL_NEST_DIR;

  beforeEach(() => {
    // biome-ignore lint/performance/noDelete: assigning undefined stringifies it to "undefined" in process.env; delete is the only way to truly unset
    delete process.env.OWL_NEST_DIR;
  });

  afterEach(() => {
    if (original === undefined) {
      // biome-ignore lint/performance/noDelete: same reason as above
      delete process.env.OWL_NEST_DIR;
    } else {
      process.env.OWL_NEST_DIR = original;
    }
  });

  it('without env, falls back to ~/orpheus-aviary-nest', () => {
    assert.equal(nestDir(), join(homedir(), 'orpheus-aviary-nest'));
  });

  it('honors OWL_NEST_DIR when set', () => {
    process.env.OWL_NEST_DIR = '/tmp/owl-profileB';
    assert.equal(nestDir(), '/tmp/owl-profileB');
  });

  it('treats empty OWL_NEST_DIR as unset', () => {
    process.env.OWL_NEST_DIR = '';
    assert.equal(nestDir(), join(homedir(), 'orpheus-aviary-nest'));
  });

  it('re-evaluates per call (no module-level caching)', () => {
    process.env.OWL_NEST_DIR = '/tmp/profile-A';
    assert.equal(nestDir(), '/tmp/profile-A');
    process.env.OWL_NEST_DIR = '/tmp/profile-B';
    assert.equal(nestDir(), '/tmp/profile-B');
  });

  it('all downstream getters follow nestDir()', () => {
    process.env.OWL_NEST_DIR = '/tmp/owl-x';
    assert.equal(owlDir(), '/tmp/owl-x/owl');
    assert.equal(configPath(), '/tmp/owl-x/owl/owl_config.toml');
    assert.equal(dbPath(), '/tmp/owl-x/owl/owl.db');
    assert.equal(syncDbPath(), '/tmp/owl-x/owl/owl.sync.db');
    assert.equal(logDir(), '/tmp/owl-x/owl/logs');
    assert.equal(owlLogPath(), '/tmp/owl-x/owl/logs/owl.log');
    assert.equal(daemonLogPath(), '/tmp/owl-x/owl/logs/daemon.log');
    assert.equal(pidPath(), '/tmp/owl-x/owl/daemon.pid');
    assert.equal(aviaryConfigPath(), '/tmp/owl-x/aviary/aviary_config.toml');
  });

  it('flipping env between two getters reflects current env', () => {
    process.env.OWL_NEST_DIR = '/tmp/A';
    const a = dbPath();
    process.env.OWL_NEST_DIR = '/tmp/B';
    const b = dbPath();
    assert.equal(a, '/tmp/A/owl/owl.db');
    assert.equal(b, '/tmp/B/owl/owl.db');
  });
});
