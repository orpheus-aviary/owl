/**
 * 0.6.2 W3 — `isAccountProfile` + the four-way initial snapshot it feeds.
 *
 * These two decide whether a daemon that starts with no session says「需登录」
 * or stays quietly「已同步/本地」, so the false-positive cases (unit-test
 * in-memory dbs, the account-less local profile) matter as much as the happy
 * path: getting them wrong would show a login prompt to every local-only user.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  createDatabase,
  ensureDeviceId,
  paths,
  persistSkybridgeIds,
  removeSkybridgeConfig,
  writeSkybridgeConfig,
} from '@owl/core';
import type Database from 'better-sqlite3';
import type { AppContext } from '../context.js';
import { EventsBus } from '../events/bus.js';
import { isAccountProfile } from './account-profile.js';
import { createSyncStatusBroadcaster } from './status-broadcaster.js';

let nestDir: string;
let priorEnv: string | undefined;
const open: Database.Database[] = [];

before(() => {
  nestDir = mkdtempSync(join(tmpdir(), 'owl-account-profile-'));
  priorEnv = process.env.OWL_NEST_DIR;
  process.env.OWL_NEST_DIR = nestDir;
});

after(() => {
  for (const s of open) s.close();
  if (priorEnv === undefined) process.env.OWL_NEST_DIR = undefined;
  else process.env.OWL_NEST_DIR = priorEnv;
  rmSync(nestDir, { recursive: true, force: true });
});

beforeEach(() => {
  removeSkybridgeConfig();
});

function makeCtx(dbPath: string, mode: 'local' | 'cloud' = 'local'): AppContext {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const { db, sqlite } = createDatabase({ dbPath });
  open.push(sqlite);
  ensureDeviceId(db);
  const config = structuredClone(DEFAULT_CONFIG);
  config.daemon.mode = mode;
  return { db, sqlite, config, eventsBus: new EventsBus() } as unknown as AppContext;
}

/** A profile db carrying an account binding, at a real (non-local) path. */
function makeAccountCtx(name: string): AppContext {
  const ctx = makeCtx(join(nestDir, `${name}.db`));
  persistSkybridgeIds(ctx.sqlite, 'dev-1', 'ws-1');
  return ctx;
}

function writeCredentials(opts: { access?: boolean; refresh?: boolean }): void {
  writeSkybridgeConfig({
    server: { url: 'http://sync.example.test' },
    auth: {
      user_id: 'u1',
      email: 'a@test',
      encrypted_token: opts.access === false ? undefined : 'ZW5j',
      encrypted_refresh_token: opts.refresh ? 'cmVm' : undefined,
    },
    device: { id: 'dev-1', name: 'test', app_version: 'owl test', client_version: '0' },
    workspace: { id: 'ws-1', slug: 'owl/default' },
  });
}

describe('isAccountProfile (0.6.2 W3)', () => {
  it('an in-memory db is never an account (daemon unit tests keep their old state)', () => {
    assert.equal(isAccountProfile(makeCtx(':memory:')), false);
  });

  it('the local profile db is never an account, even if it carries a binding', () => {
    const ctx = makeCtx(paths.localProfileDbPath());
    persistSkybridgeIds(ctx.sqlite, 'dev-legacy', 'ws-legacy');
    assert.equal(isAccountProfile(ctx), false, 'D10b: owl/owl.db is account-less by definition');
  });

  it('a real profile db without a workspace binding is not an account', () => {
    assert.equal(isAccountProfile(makeCtx(join(nestDir, 'unbound.db'))), false);
  });

  it('a real profile db with a workspace binding is an account', () => {
    assert.equal(isAccountProfile(makeAccountCtx('bound')), true);
  });

  it('cloud mode: an installed session is enough', () => {
    const ctx = makeCtx(':memory:', 'cloud');
    assert.equal(isAccountProfile(ctx), false);
    ctx.skybridgeSession = {} as AppContext['skybridgeSession'];
    assert.equal(isAccountProfile(ctx), true);
  });
});

describe('initial snapshot — the four branches (0.6.2 W3)', () => {
  it('an installed session starts idle', () => {
    const ctx = makeAccountCtx('has-session');
    ctx.skybridgeSession = {} as AppContext['skybridgeSession'];
    assert.equal(createSyncStatusBroadcaster(ctx).snapshot().state, 'idle');
  });

  it('a non-account profile starts idle even with credentials on disk', () => {
    writeCredentials({ refresh: true });
    const ctx = makeCtx(join(nestDir, 'local-ish.db'));
    const snap = createSyncStatusBroadcaster(ctx).snapshot();
    assert.equal(snap.state, 'idle');
    assert.equal(snap.auth_reason, null);
  });

  it('an account profile with recoverable credentials starts at missing_session', () => {
    writeCredentials({ refresh: true });
    const snap = createSyncStatusBroadcaster(makeAccountCtx('recoverable')).snapshot();
    assert.equal(snap.state, 'auth_required');
    assert.equal(snap.auth_reason, 'missing_session');
  });

  it('an account profile with no credentials left starts at credentials_missing', () => {
    // No toml at all → nothing to reinstall and nothing to refresh with.
    const snap = createSyncStatusBroadcaster(makeAccountCtx('stranded')).snapshot();
    assert.equal(snap.state, 'auth_required');
    assert.equal(snap.auth_reason, 'credentials_missing');
  });
});
