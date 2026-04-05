import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from './index.js';

const TEST_DIR = join(tmpdir(), `owl-config-test-${Date.now()}`);
const TEST_CONFIG_PATH = join(TEST_DIR, 'owl_config.toml');

describe('config', () => {
  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('creates default config when file missing', () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.ok(existsSync(TEST_CONFIG_PATH));
    assert.equal(config.daemon.port, 47010);
    assert.equal(config.window.width, 1000);
    assert.equal(config.trash.auto_delete_days, 30);
  });

  it('loads existing config', () => {
    const config = loadConfig(TEST_CONFIG_PATH);
    assert.deepEqual(config.navigation.order, DEFAULT_CONFIG.navigation.order);
  });

  it('merges partial config with defaults', () => {
    const partial = `
[daemon]
port = 9999

[window]
width = 1200
`;
    writeFileSync(TEST_CONFIG_PATH, partial, 'utf-8');

    const config = loadConfig(TEST_CONFIG_PATH);
    assert.equal(config.daemon.port, 9999);
    assert.equal(config.window.width, 1200);
    // Defaults should fill missing fields
    assert.equal(config.window.height, 700);
    assert.equal(config.daemon.poll_interval_min, 1);
    assert.equal(config.log.level, 'info');
  });

  it('saves and reloads config', () => {
    const config = { ...DEFAULT_CONFIG, daemon: { ...DEFAULT_CONFIG.daemon, port: 12345 } };
    const savePath = join(TEST_DIR, 'save_test.toml');
    saveConfig(config, savePath);

    const loaded = loadConfig(savePath);
    assert.equal(loaded.daemon.port, 12345);
  });
});
