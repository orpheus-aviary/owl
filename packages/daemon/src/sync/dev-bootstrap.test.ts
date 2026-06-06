/**
 * P5-d Phase 6 — dev double-env gate tests.
 *
 * Pinned env / readSkybridgeConfig via DI so the suite never touches the
 * real process.env or the on-disk skybridge_config.toml.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SkybridgeConfig } from '@owl/core';
import { DevTokenInProductionError, tryConsumeDevSession } from './dev-bootstrap.js';

function completeConfig(): SkybridgeConfig {
  return {
    server: { url: 'http://127.0.0.1:18443' },
    auth: { user_id: 'u-A', token: 'placeholder-from-toml', email: 'a@test' },
    device: {
      id: 'dev-A',
      name: 'mac-a',
      app_version: 'owl 0.5.0',
      client_version: '0.1.0',
    },
    workspace: { id: 'ws-A', slug: 'owl/default' },
  };
}

function deleter(deleted: string[]): (env: NodeJS.ProcessEnv, key: string) => void {
  return (env: NodeJS.ProcessEnv, key: string): void => {
    deleted.push(key);
    // biome-ignore lint/performance/noDelete: matches production helper semantics
    delete env[key];
  };
}

describe('tryConsumeDevSession (P5-d Phase 6)', () => {
  it('reason="no-env" when neither dev env var is set', () => {
    const res = tryConsumeDevSession({
      env: {},
      readSkybridgeConfig: () => completeConfig(),
    });
    assert.equal(res.reason, 'no-env');
    assert.equal(res.input, null);
  });

  it('reason="partial-env" when only OWL_DAEMON_DEV_TOKEN is set', () => {
    const env = { OWL_DAEMON_DEV_TOKEN: 'tk-1' };
    const deleted: string[] = [];
    const res = tryConsumeDevSession({
      env,
      deleteEnv: deleter(deleted),
      readSkybridgeConfig: () => completeConfig(),
    });
    assert.equal(res.reason, 'partial-env');
    assert.equal(res.input, null);
    assert.deepEqual(deleted, [], 'partial env must not be deleted');
    assert.equal(env.OWL_DAEMON_DEV_TOKEN, 'tk-1', 'env preserved for debugging');
  });

  it('reason="partial-env" when OWL_ALLOW_INSECURE_DEV_TOKEN is not "1"', () => {
    const res = tryConsumeDevSession({
      env: { OWL_DAEMON_DEV_TOKEN: 'tk-1', OWL_ALLOW_INSECURE_DEV_TOKEN: 'true' },
      readSkybridgeConfig: () => completeConfig(),
    });
    assert.equal(res.reason, 'partial-env');
  });

  it('throws DevTokenInProductionError when NODE_ENV=production + both env set', () => {
    const env = {
      NODE_ENV: 'production',
      OWL_DAEMON_DEV_TOKEN: 'tk-1',
      OWL_ALLOW_INSECURE_DEV_TOKEN: '1',
    };
    const deleted: string[] = [];
    assert.throws(
      () =>
        tryConsumeDevSession({
          env,
          deleteEnv: deleter(deleted),
          readSkybridgeConfig: () => completeConfig(),
        }),
      DevTokenInProductionError,
    );
    assert.deepEqual(deleted, [], 'production reject must not delete env');
    assert.equal(env.OWL_DAEMON_DEV_TOKEN, 'tk-1');
  });

  it('reason="toml-incomplete" when readSkybridgeConfig throws', () => {
    const env = { OWL_DAEMON_DEV_TOKEN: 'tk-1', OWL_ALLOW_INSECURE_DEV_TOKEN: '1' };
    const deleted: string[] = [];
    const res = tryConsumeDevSession({
      env,
      deleteEnv: deleter(deleted),
      readSkybridgeConfig: () => {
        throw new Error('toml not found');
      },
    });
    assert.equal(res.reason, 'toml-incomplete');
    assert.equal(res.input, null);
    assert.deepEqual(deleted, [], 'incomplete toml must not delete env');
  });

  it('reason="toml-incomplete" when toml lacks workspace.id', () => {
    const cfg = completeConfig();
    cfg.workspace = undefined;
    const res = tryConsumeDevSession({
      env: { OWL_DAEMON_DEV_TOKEN: 'tk-1', OWL_ALLOW_INSECURE_DEV_TOKEN: '1' },
      readSkybridgeConfig: () => cfg,
    });
    assert.equal(res.reason, 'toml-incomplete');
  });

  it('reason="accepted" when both env + complete toml; env deleted; token from env wins over toml', () => {
    const env = { OWL_DAEMON_DEV_TOKEN: 'tk-from-env', OWL_ALLOW_INSECURE_DEV_TOKEN: '1' };
    const deleted: string[] = [];
    const res = tryConsumeDevSession({
      env,
      deleteEnv: deleter(deleted),
      readSkybridgeConfig: () => completeConfig(),
    });
    assert.equal(res.reason, 'accepted');
    assert.ok(res.input);
    assert.equal(res.input.token, 'tk-from-env', 'env token wins over toml-stored token');
    assert.equal(res.input.user_id, 'u-A');
    assert.equal(res.input.email, 'a@test');
    assert.equal(res.input.server_url, 'http://127.0.0.1:18443');
    assert.equal(res.input.device.id, 'dev-A');
    assert.equal(res.input.workspace.id, 'ws-A');

    assert.deepEqual(deleted.sort(), ['OWL_ALLOW_INSECURE_DEV_TOKEN', 'OWL_DAEMON_DEV_TOKEN']);
    assert.equal(env.OWL_DAEMON_DEV_TOKEN, undefined);
    assert.equal(env.OWL_ALLOW_INSECURE_DEV_TOKEN, undefined);
  });

  it('accepts when NODE_ENV is unset (treats as dev)', () => {
    const res = tryConsumeDevSession({
      env: { OWL_DAEMON_DEV_TOKEN: 'tk-1', OWL_ALLOW_INSECURE_DEV_TOKEN: '1' },
      readSkybridgeConfig: () => completeConfig(),
    });
    assert.equal(res.reason, 'accepted');
  });

  it('accepts when NODE_ENV=test (treats as dev)', () => {
    const res = tryConsumeDevSession({
      env: {
        NODE_ENV: 'test',
        OWL_DAEMON_DEV_TOKEN: 'tk-1',
        OWL_ALLOW_INSECURE_DEV_TOKEN: '1',
      },
      readSkybridgeConfig: () => completeConfig(),
    });
    assert.equal(res.reason, 'accepted');
  });
});
