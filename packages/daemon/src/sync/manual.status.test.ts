/**
 * Phase A (A4, §6 / §9 #7) — readSyncStatus cloud source.
 *
 * A cloud daemon keeps credentials in RAM (never toml), so status must read the
 * binding from the CredentialStore / installed session rather than reporting
 * `configured:false` off an absent toml.
 *
 * Local source (regression) — an installed `ctx.skybridgeSession` is the
 * authoritative binding even in local mode: GUI main writes the toml profile
 * section AFTER `/sync/session` installs the session, so a toml read at install
 * time reports null device/workspace. Reading the session keeps the status
 * broadcaster from flashing「已同步」→「本地」and manual sync from reverting.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, type OwlConfig, createDatabase } from '@owl/core';
import type Database from 'better-sqlite3';
import type { AppContext } from '../context.js';
import { CredentialStore } from '../credential-store.js';
import { readSyncStatus } from './manual.js';
import type { SkybridgeSession } from './session.js';

const SERVER = 'http://127.0.0.1:18443';

function cloudCtx(): { ctx: AppContext; sqlite: Database.Database; store: CredentialStore } {
  const { sqlite } = createDatabase({ dbPath: ':memory:' });
  const config: OwlConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    daemon: {
      ...DEFAULT_CONFIG.daemon,
      mode: 'cloud',
      server_url: SERVER,
      account_lock: 'off',
      public_url: 'http://127.0.0.1:47010',
    },
  };
  const store = new CredentialStore();
  const ctx = {
    config,
    sqlite,
    credentialStore: store,
    skybridgeSession: null,
  } as unknown as AppContext;
  return { ctx, sqlite, store };
}

describe('readSyncStatus — cloud mode', () => {
  it('reports unconfigured when no account is bound', () => {
    const { ctx, sqlite } = cloudCtx();
    const status = readSyncStatus(ctx);
    assert.equal(status.configured, false);
    assert.equal(status.authenticated, false);
    assert.equal(status.server_url, null);
    assert.equal(status.device_id, null);
    assert.equal(status.workspace_id, null);
    sqlite.close();
  });

  it('reads server_url / device / workspace from the RAM credential store', () => {
    const { ctx, sqlite, store } = cloudCtx();
    store.set({
      serverUrl: SERVER,
      serverId: 'srv-1',
      userId: 'u-1',
      email: 'a@test',
      profileId: 'p-1',
      deviceId: 'dev-9',
      workspaceId: 'ws-9',
      token: 'tok',
      refreshToken: 'ref',
    });
    const status = readSyncStatus(ctx);
    assert.equal(status.configured, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.server_url, SERVER);
    assert.equal(status.device_id, 'dev-9');
    assert.equal(status.workspace_id, 'ws-9');
    sqlite.close();
  });
});

function localCtx(): { ctx: AppContext; sqlite: Database.Database } {
  const { sqlite } = createDatabase({ dbPath: ':memory:' });
  const config: OwlConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    daemon: { ...DEFAULT_CONFIG.daemon, mode: 'local' },
  };
  const ctx = {
    config,
    sqlite,
    credentialStore: null,
    skybridgeSession: null,
  } as unknown as AppContext;
  return { ctx, sqlite };
}

function installFakeSession(ctx: AppContext): void {
  ctx.skybridgeSession = {
    realClient: {} as SkybridgeSession['realClient'],
    module: {} as SkybridgeSession['module'],
    config: { server: { url: SERVER } } as SkybridgeSession['config'],
    workspaceId: 'ws-live',
    deviceId: 'dev-live',
    serverUrl: SERVER,
  };
}

describe('readSyncStatus — local mode', () => {
  it('reads server_url / device / workspace from the installed session', () => {
    // Regression: the toml profile section is written only AFTER /sync/session
    // installs the session, so status must not depend on it. No toml is written
    // here, yet an installed session must still report the account binding —
    // this is what stops the bar from reverting to「本地」post-install.
    const { ctx, sqlite } = localCtx();
    installFakeSession(ctx);
    const status = readSyncStatus(ctx);
    assert.equal(status.configured, true);
    assert.equal(status.authenticated, true);
    assert.equal(status.server_url, SERVER);
    assert.equal(status.device_id, 'dev-live');
    assert.equal(status.workspace_id, 'ws-live');
    sqlite.close();
  });

  it('reads cursor pulled_seq / pushed_seq keyed by the session server_url', () => {
    const { ctx, sqlite } = localCtx();
    installFakeSession(ctx);
    sqlite
      .prepare(
        'INSERT INTO sync_cursor (endpoint, pulled_seq, pushed_seq, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(SERVER, 21, 7, 98765);
    const status = readSyncStatus(ctx);
    assert.equal(status.pulled_seq, 21);
    assert.equal(status.pushed_seq, 7);
    assert.equal(status.last_sync_at, 98765);
    sqlite.close();
  });
});
