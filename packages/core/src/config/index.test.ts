import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_CONFIG, effectiveSyncIntervalMin, loadConfig, saveConfig } from './index.js';

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
    // Phase A — [daemon].mode/bind backfill to the local defaults when absent.
    assert.equal(config.daemon.mode, 'local');
    assert.equal(config.daemon.bind, '127.0.0.1');
  });

  it('reads Phase A cloud [daemon] fields from toml', () => {
    const cloud = `
[daemon]
mode = "cloud"
bind = "0.0.0.0"
server_url = "http://127.0.0.1:18443"
account_lock = "off"
public_url = "https://owl.example.com"
allowed_origins = ["https://owl.example.com"]
allowed_hosts = ["owl.example.com"]
session_ttl_min = 60
trust_proxy = true
`;
    const cloudPath = join(TEST_DIR, 'cloud.toml');
    writeFileSync(cloudPath, cloud, 'utf-8');

    const config = loadConfig(cloudPath);
    assert.equal(config.daemon.mode, 'cloud');
    assert.equal(config.daemon.bind, '0.0.0.0');
    assert.equal(config.daemon.server_url, 'http://127.0.0.1:18443');
    assert.equal(config.daemon.account_lock, 'off');
    assert.equal(config.daemon.public_url, 'https://owl.example.com');
    assert.deepEqual(config.daemon.allowed_origins, ['https://owl.example.com']);
    assert.deepEqual(config.daemon.allowed_hosts, ['owl.example.com']);
    assert.equal(config.daemon.session_ttl_min, 60);
    assert.equal(config.daemon.trust_proxy, true);
  });

  it('saves and reloads config', () => {
    const config = { ...DEFAULT_CONFIG, daemon: { ...DEFAULT_CONFIG.daemon, port: 12345 } };
    const savePath = join(TEST_DIR, 'save_test.toml');
    saveConfig(config, savePath);

    const loaded = loadConfig(savePath);
    assert.equal(loaded.daemon.port, 12345);
  });
});

// P5-c §3.5 — interval clamp rules for [sync].interval_min.
// loadConfig stays a pure read (no logger); the helper centralises the
// fallback / clamp / disable semantics so daemon scheduler + tests
// share a single source.
describe('effectiveSyncIntervalMin (P5-c §3.5)', () => {
  it('returns the raw value when it is a finite minute >= 1', () => {
    assert.equal(effectiveSyncIntervalMin({ interval_min: 5 }), 5);
    assert.equal(effectiveSyncIntervalMin({ interval_min: 60 }), 60);
    assert.equal(effectiveSyncIntervalMin({ interval_min: 1 }), 1);
    assert.equal(effectiveSyncIntervalMin({ interval_min: 2.5 }), 2.5);
  });

  it('returns 0 (disabled) when raw is <= 0', () => {
    assert.equal(effectiveSyncIntervalMin({ interval_min: 0 }), 0);
    assert.equal(effectiveSyncIntervalMin({ interval_min: -1 }), 0);
    assert.equal(effectiveSyncIntervalMin({ interval_min: -999 }), 0);
  });

  it('clamps to 1 when raw is in (0, 1)', () => {
    assert.equal(effectiveSyncIntervalMin({ interval_min: 0.5 }), 1);
    assert.equal(effectiveSyncIntervalMin({ interval_min: 0.001 }), 1);
  });

  it('silently falls back to 5 for non-finite or wrong-type values', () => {
    assert.equal(effectiveSyncIntervalMin({ interval_min: Number.NaN }), 5);
    assert.equal(effectiveSyncIntervalMin({ interval_min: Number.POSITIVE_INFINITY }), 5);
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime-only bad types
    assert.equal(effectiveSyncIntervalMin({ interval_min: 'five' as any }), 5);
    // biome-ignore lint/suspicious/noExplicitAny: testing runtime-only bad types
    assert.equal(effectiveSyncIntervalMin({ interval_min: undefined as any }), 5);
  });
});
