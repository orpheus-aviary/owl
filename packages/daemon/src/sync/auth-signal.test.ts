/**
 * 0.6.2 W3 — `signalAuthRequired` routing.
 *
 * The interesting case is the NON-account profile: the caller (manual sync)
 * has already called `markSyncing`, so a silent return would leave the status
 * bar spinning at「同步中」forever. It must land on a plain error instead.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  createDatabase,
  ensureDeviceId,
  persistSkybridgeIds,
  removeSkybridgeConfig,
  writeSkybridgeConfig,
} from '@owl/core';
import type Database from 'better-sqlite3';
import type { AppContext } from '../context.js';
import { EventsBus } from '../events/bus.js';
import { signalAuthRequired } from './auth-signal.js';
import { getSyncStatusBroadcaster } from './status-broadcaster.js';

let nestDir: string;
let priorEnv: string | undefined;
const open: Database.Database[] = [];

before(() => {
  nestDir = mkdtempSync(join(tmpdir(), 'owl-auth-signal-'));
  priorEnv = process.env.OWL_NEST_DIR;
  process.env.OWL_NEST_DIR = nestDir;
  removeSkybridgeConfig();
});

after(() => {
  for (const s of open) s.close();
  if (priorEnv === undefined) process.env.OWL_NEST_DIR = undefined;
  else process.env.OWL_NEST_DIR = priorEnv;
  rmSync(nestDir, { recursive: true, force: true });
});

function makeCtx(dbPath: string, account: boolean): AppContext {
  if (dbPath !== ':memory:') mkdirSync(join(dbPath, '..'), { recursive: true });
  const { db, sqlite } = createDatabase({ dbPath });
  open.push(sqlite);
  ensureDeviceId(db);
  if (account) persistSkybridgeIds(sqlite, 'dev-1', 'ws-1');
  return {
    db,
    sqlite,
    eventsBus: new EventsBus(),
    config: structuredClone(DEFAULT_CONFIG),
  } as unknown as AppContext;
}

describe('signalAuthRequired (0.6.2 W3)', () => {
  it('an account profile gets the auth state + reason', () => {
    // Credentials on disk → the initial snapshot is the recoverable
    // `missing_session`, which a real 401 may legitimately escalate.
    writeSkybridgeConfig({
      server: { url: 'http://sync.example.test' },
      auth: { user_id: 'u1', email: 'a@test', encrypted_token: 'ZW5j' },
      device: { id: 'dev-1', name: 't', app_version: 'owl test', client_version: '0' },
      workspace: { id: 'ws-1', slug: 'owl/default' },
    });
    const ctx = makeCtx(join(nestDir, 'acct.db'), true);
    signalAuthRequired(ctx, 'token_rejected', '401');
    const snap = getSyncStatusBroadcaster(ctx).snapshot();
    assert.equal(snap.state, 'auth_required');
    assert.equal(snap.auth_reason, 'token_rejected');
  });

  it('a non-account profile gets a plain error — never left at 同步中', () => {
    const ctx = makeCtx(join(nestDir, 'plain.db'), false);
    const broadcaster = getSyncStatusBroadcaster(ctx);
    broadcaster.markSyncing();
    assert.equal(broadcaster.snapshot().state, 'syncing');

    signalAuthRequired(ctx, 'missing_session', 'no session installed');

    assert.equal(broadcaster.snapshot().state, 'error');
    assert.equal(broadcaster.snapshot().auth_reason, null);
    assert.equal(broadcaster.snapshot().last_error, 'no session installed');
  });
});
