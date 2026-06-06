/**
 * P5-d Phase 6 — `installSkybridgeSession` unit tests.
 *
 * Exercises the in-memory session install path called by `/sync/session`:
 *   - builds a SkybridgeConfig from explicit HTTP body fields (no toml read)
 *   - calls `persistSkybridgeIds` positionally (sqlite, deviceId, workspaceId)
 *   - sets `ctx.skybridgeSession`
 *   - replace semantics: a second call overwrites both ctx + local_metadata
 *
 * Uses the real `@orpheus-aviary/skybridge-client` module (declared as a
 * prod dep of daemon since 0.4.2), so `loadSkybridgeClient` succeeds.
 * `createSkybridgeClient` is a no-network constructor call.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  type OwlDatabase,
  createConsoleLogger,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
} from '@owl/core';
import type Database from 'better-sqlite3';
import type { AppContext } from '../context.js';
import { type InstallSessionInput, installSkybridgeSession } from './session.js';

function readMeta(sqlite: Database.Database, key: string): string | undefined {
  const row = sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? undefined;
}

function bodyA(): InstallSessionInput {
  return {
    token: 'tk-A',
    user_id: 'u-A',
    email: 'a@test',
    server_url: 'http://127.0.0.1:18443',
    device: { id: 'dev-A', name: 'mac-a' },
    workspace: { id: 'ws-A', slug: 'owl/default' },
  };
}

function bodyB(): InstallSessionInput {
  return {
    token: 'tk-B',
    user_id: 'u-B',
    email: 'b@test',
    server_url: 'http://127.0.0.1:18443',
    device: { id: 'dev-B', name: 'mac-b' },
    workspace: { id: 'ws-B', slug: 'owl/default' },
  };
}

describe('installSkybridgeSession (P5-d Phase 6)', () => {
  let sqlite: Database.Database;
  let db: OwlDatabase;
  let ctx: AppContext;

  before(() => {
    const created = createDatabase({ dbPath: ':memory:' });
    sqlite = created.sqlite;
    db = created.db;
    ensureSpecialNotes(db);
    ensureDeviceId(db);
    ctx = {
      sqlite,
      db,
      logger: createConsoleLogger('install-session-test', 'silent'),
      skybridgeSession: null,
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub for unit test
    } as any;
  });

  after(() => {
    sqlite.close();
  });

  beforeEach(() => {
    ctx.skybridgeSession = null;
    sqlite
      .prepare(
        "DELETE FROM local_metadata WHERE key IN ('skybridge_device_id', 'skybridge_workspace_id', 'skybridge_backfilled')",
      )
      .run();
  });

  it('sets ctx.skybridgeSession with the input identity', async () => {
    const session = await installSkybridgeSession(ctx, bodyA());
    assert.equal(session.deviceId, 'dev-A');
    assert.equal(session.workspaceId, 'ws-A');
    assert.equal(session.serverUrl, 'http://127.0.0.1:18443');
    assert.equal(
      ctx.skybridgeSession,
      session,
      'ctx.skybridgeSession must point at returned session',
    );
    assert.equal(session.config.auth?.token, 'tk-A', 'config carries the token in-memory only');
    assert.equal(session.config.auth?.email, 'a@test');
  });

  it('persists skybridge_device_id + skybridge_workspace_id into local_metadata (positional call)', async () => {
    await installSkybridgeSession(ctx, bodyA());
    assert.equal(readMeta(sqlite, 'skybridge_device_id'), 'dev-A');
    assert.equal(readMeta(sqlite, 'skybridge_workspace_id'), 'ws-A');
    // backfill sentinel is set as a side effect of persistSkybridgeIds.
    assert.equal(readMeta(sqlite, 'skybridge_backfilled'), '1');
  });

  it('replace semantics: a second call overwrites ctx + local_metadata', async () => {
    await installSkybridgeSession(ctx, bodyA());
    assert.equal(readMeta(sqlite, 'skybridge_device_id'), 'dev-A');

    const second = await installSkybridgeSession(ctx, bodyB());
    assert.equal(second.deviceId, 'dev-B', 'returned session reflects second input');
    assert.equal(ctx.skybridgeSession?.deviceId, 'dev-B');
    assert.equal(ctx.skybridgeSession?.workspaceId, 'ws-B');
    assert.equal(readMeta(sqlite, 'skybridge_device_id'), 'dev-B');
    assert.equal(readMeta(sqlite, 'skybridge_workspace_id'), 'ws-B');
  });

  it('fills app_version / client_version / slug defaults when body omits them', async () => {
    const session = await installSkybridgeSession(ctx, {
      ...bodyA(),
      device: { id: 'dev-A', name: 'mac-a' }, // no app_version / client_version
      workspace: { id: 'ws-A' }, // no slug
    });
    assert.match(
      session.config.device?.app_version ?? '',
      /owl 0\.5\.0/,
      'app_version defaults to current OWL_APP_VERSION',
    );
    assert.equal(session.config.workspace?.slug, 'owl/default', 'slug defaults to owl/default');
  });
});
