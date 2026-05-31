import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_CONFIG,
  type Logger,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
} from '@owl/core';
import BetterSqlite3 from 'better-sqlite3';
import { ConversationStore } from '../ai/conversations.js';
import { PreviewStore } from '../ai/preview-store.js';
import type { AppContext } from '../context.js';
import { EventsBus } from '../events/bus.js';
import { ReminderScheduler } from '../scheduler.js';
import { switchProfile } from './profile-switch.js';
import type { SkybridgeSession } from './session.js';
import { getSyncStatusBroadcaster } from './status-broadcaster.js';
import { createSwitchGate } from './switch-gate.js';

function silentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

/** Open + migrate a fresh db, returning its (capturable) device id. */
function seedDb(dbPath: string): string {
  const { db, sqlite } = createDatabase({ dbPath });
  const deviceId = ensureDeviceId(db);
  ensureSpecialNotes(db);
  sqlite.close();
  return deviceId;
}

function pendingChange(sqlite: BetterSqlite3.Database, id: string): void {
  sqlite
    .prepare(
      'INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload, created_at) VALUES (?,?,?,?,?,?)',
    )
    .run('dev', 'note', id, 'create', '{}', 0);
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
    toolRegistry: {} as never,
    conversationStore: new ConversationStore(sqlite),
    previewStore: new PreviewStore(),
    eventsBus: new EventsBus(),
    skybridgeSession: null,
    sseBridge: null,
    syncScheduler: null,
    switchGate: createSwitchGate(),
  } as AppContext;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'owl-switch-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('switchProfile (P5-d Phase 14)', () => {
  it('swaps db/sqlite/deviceId/scheduler/store and clears session; returns {warnings:[]}', async () => {
    const ctx = makeCtx(join(tmp, 'a.db'));
    const bPath = join(tmp, 'b.db');
    const bDeviceId = seedDb(bPath);

    const oldSqlite = ctx.sqlite;
    const oldScheduler = ctx.scheduler;
    const oldConvStore = ctx.conversationStore;
    const oldPreview = ctx.previewStore;
    ctx.skybridgeSession = { workspaceId: 'ws' } as unknown as SkybridgeSession;

    const result = await switchProfile(ctx, bPath, silentLogger());

    assert.deepEqual(result.warnings, []);
    assert.equal(ctx.deviceId, bDeviceId, 'deviceId is now B');
    assert.notEqual(ctx.sqlite, oldSqlite, 'sqlite replaced');
    assert.notEqual(ctx.scheduler, oldScheduler, 'scheduler rebuilt');
    assert.notEqual(ctx.conversationStore, oldConvStore, 'conversationStore rebuilt');
    assert.notEqual(ctx.previewStore, oldPreview, 'previewStore replaced');
    assert.equal(ctx.skybridgeSession, null, 'session cleared');
    // old sqlite closed
    assert.throws(() => oldSqlite.prepare('SELECT 1').get(), /not open|closed/i);
    // new db usable
    assert.doesNotThrow(() => ctx.sqlite.prepare('SELECT 1').get());
  });

  it('evicts the broadcaster WeakMap → fresh snapshot off the new db (P2-f)', async () => {
    const ctx = makeCtx(join(tmp, 'a.db'));
    pendingChange(ctx.sqlite, 'c1');
    pendingChange(ctx.sqlite, 'c2');
    const bPath = join(tmp, 'b.db');
    seedDb(bPath); // B has 0 pending changes

    const before = getSyncStatusBroadcaster(ctx);
    assert.equal(before, getSyncStatusBroadcaster(ctx), 'cached before switch');
    assert.equal(before.snapshot().pending_count, 2, 'A has 2 pending');

    await switchProfile(ctx, bPath, silentLogger());

    const after = getSyncStatusBroadcaster(ctx);
    assert.notEqual(after, before, 'broadcaster rebuilt (WeakMap evicted)');
    assert.equal(after.snapshot().pending_count, 0, 'reads B (DB-backed field)');
  });

  it('aborts cleanly when the target db is incompatible — ctx untouched (P1-c)', async () => {
    const ctx = makeCtx(join(tmp, 'a.db'));
    const oldSqlite = ctx.sqlite;
    const oldScheduler = ctx.scheduler;

    // Craft a db from a newer schema version → createDatabase throws.
    const badPath = join(tmp, 'bad.db');
    const bad = new BetterSqlite3(badPath);
    bad.pragma('user_version = 9999');
    bad.close();

    await assert.rejects(switchProfile(ctx, badPath, silentLogger()));

    assert.equal(ctx.sqlite, oldSqlite, 'sqlite unchanged');
    assert.equal(ctx.scheduler, oldScheduler, 'scheduler unchanged (not stopped/replaced)');
    assert.doesNotThrow(() => ctx.sqlite.prepare('SELECT 1').get(), 'old db still open');
  });

  it('post-commit failure resolves with warnings, never rejects (P4)', async () => {
    const ctx = makeCtx(join(tmp, 'a.db'));
    const bPath = join(tmp, 'b.db');
    const bDeviceId = seedDb(bPath);

    // Force the old-db close to throw — exercises the COMMIT-phase warning path.
    (ctx.sqlite as unknown as { close: () => void }).close = () => {
      throw new Error('boom-close');
    };

    const result = await switchProfile(ctx, bPath, silentLogger());

    assert.ok(
      result.warnings.some((w) => w.includes('old db close')),
      `expected an old-db-close warning, got ${JSON.stringify(result.warnings)}`,
    );
    assert.equal(ctx.deviceId, bDeviceId, 'still committed to B despite the warning');
  });
});
