/**
 * P5-d Phase 15 — POST /sync/switch route + switch-gate exemption.
 *
 * switchProfile swaps ctx.db/sqlite on disk, so these use real profile dbs
 * inside a temp nest (not `:memory:`). The route is also the live trigger for
 * the gate, so a plain successful switch doubles as the self-deadlock
 * regression: if /sync/switch were counted as an in-flight mutation,
 * switchProfile's drain would wait on it forever and the inject would hang.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_CONFIG,
  type Logger,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
  paths,
  persistSkybridgeIds,
} from '@owl/core';
import { ConversationStore } from '../ai/conversations.js';
import { PreviewStore } from '../ai/preview-store.js';
import { createBuiltinRegistry } from '../ai/tools/index.js';
import type { AppContext } from '../context.js';
import { EventsBus } from '../events/bus.js';
import { ReminderScheduler } from '../scheduler.js';
import { buildTestServer } from '../testing/build-test-server.js';
import { createSwitchGate, ensureSwitchGate } from './switch-gate.js';

const HEX = 'a'.repeat(32);

function silentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

function makeCtx(dbPath: string): AppContext {
  const { db, sqlite } = createDatabase({ dbPath });
  const deviceId = ensureDeviceId(db);
  ensureSpecialNotes(db);
  const config = DEFAULT_CONFIG;
  const logger = silentLogger();
  return {
    db,
    sqlite,
    config,
    logger,
    deviceId,
    scheduler: new ReminderScheduler(db, sqlite, config, logger),
    toolRegistry: createBuiltinRegistry(),
    conversationStore: new ConversationStore(sqlite),
    previewStore: new PreviewStore(),
    eventsBus: new EventsBus(),
    skybridgeSession: null,
    sseBridge: null,
    syncScheduler: null,
    switchGate: createSwitchGate(),
  } as AppContext;
}

/** Seed a profile db on disk carrying a remembered skybridge_device_id. */
function seedProfileDb(dbPath: string, skybridgeDeviceId: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  const { db, sqlite } = createDatabase({ dbPath });
  ensureDeviceId(db);
  ensureSpecialNotes(db);
  persistSkybridgeIds(sqlite, skybridgeDeviceId, 'ws-seed');
  sqlite.close();
}

describe('POST /sync/switch (P5-d Phase 15)', () => {
  let nest: string;
  let priorEnv: string | undefined;
  let ctx: AppContext;
  let app: ReturnType<typeof buildTestServer>;

  before(() => {
    priorEnv = process.env.OWL_NEST_DIR;
  });
  after(() => {
    if (priorEnv === undefined) {
      // biome-ignore lint/performance/noDelete: env must be truly unset
      delete process.env.OWL_NEST_DIR;
    } else {
      process.env.OWL_NEST_DIR = priorEnv;
    }
  });

  beforeEach(async () => {
    nest = mkdtempSync(join(tmpdir(), 'owl-switch-route-'));
    process.env.OWL_NEST_DIR = nest;
    mkdirSync(join(nest, 'owl'), { recursive: true });
    ctx = makeCtx(paths.localProfileDbPath()); // start on local = owl/owl.db
    app = buildTestServer(ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    ctx.scheduler.stop();
    (ctx.syncScheduler as { stop?: () => void } | null)?.stop?.();
    try {
      ctx.sqlite.close();
    } catch {
      // already closed by a switch
    }
    rmSync(nest, { recursive: true, force: true });
  });

  it('400 when profile_id is missing', async () => {
    const res = await app.inject({ method: 'POST', url: '/sync/switch', payload: {} });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error_code, 'USAGE_ERROR');
  });

  it('400 when profile_id is neither local nor 32-hex', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/switch',
      payload: { profile_id: 'not-hex' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error_code, 'USAGE_ERROR');
  });

  it('creates profiles/<id>/ dir + db for a fresh account and returns device_id:null', async () => {
    const target = paths.profileDbPath(HEX);
    assert.equal(existsSync(dirname(target)), false, 'dir absent before');

    const res = await app.inject({
      method: 'POST',
      url: '/sync/switch',
      payload: { profile_id: HEX },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.device_id, null, 'fresh db has no remembered device');
    assert.deepEqual(res.json().data.warnings, []);
    assert.ok(existsSync(target), 'profile db created (mkdir regression)');
  });

  it('returns the remembered skybridge_device_id when switching to a seeded profile', async () => {
    seedProfileDb(paths.profileDbPath(HEX), 'dev-reused');
    const res = await app.inject({
      method: 'POST',
      url: '/sync/switch',
      payload: { profile_id: HEX },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.device_id, 'dev-reused');
  });

  it('switches back to local', async () => {
    await app.inject({ method: 'POST', url: '/sync/switch', payload: { profile_id: HEX } });
    const res = await app.inject({
      method: 'POST',
      url: '/sync/switch',
      payload: { profile_id: 'local' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(ctx.sqlite.open, true, 'now on a live (local) db');
  });

  it('gate: during a switch, mutating routes 503 (incl. a second /sync/switch), GET passes', async () => {
    await ensureSwitchGate(ctx).runExclusive(async () => {
      // isSwitching() is true inside the exclusive body.
      const run = await app.inject({ method: 'POST', url: '/sync/run' });
      assert.equal(run.statusCode, 503);
      assert.equal(run.json().error_code, 'SWITCH_IN_PROGRESS');

      const concurrent = await app.inject({
        method: 'POST',
        url: '/sync/switch',
        payload: { profile_id: 'local' },
      });
      assert.equal(concurrent.statusCode, 503, 'a second switch is rejected, not queued');

      const status = await app.inject({ method: 'GET', url: '/sync/status' });
      assert.notEqual(status.statusCode, 503, 'GET is never gated');
    });
  });
});
