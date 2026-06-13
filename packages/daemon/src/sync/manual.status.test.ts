/**
 * Phase A (A4, §6 / §9 #7) — readSyncStatus cloud source.
 *
 * A cloud daemon keeps credentials in RAM (never toml), so status must read the
 * binding from the CredentialStore / installed session rather than reporting
 * `configured:false` off an absent toml.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CONFIG, type OwlConfig, createDatabase } from '@owl/core';
import type Database from 'better-sqlite3';
import type { AppContext } from '../context.js';
import { CredentialStore } from '../credential-store.js';
import { readSyncStatus } from './manual.js';

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
