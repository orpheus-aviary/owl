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
import { ConversationStore } from './ai/conversations.js';
import { PreviewStore } from './ai/preview-store.js';
import type { AppContext } from './context.js';
import { EventsBus } from './events/bus.js';
import { ReminderScheduler } from './scheduler.js';
import type { SwitchGate } from './sync/switch-gate.js';
import { buildTestServer } from './testing/build-test-server.js';

function silentLogger(): Logger {
  const noop = (): void => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

/** A gate whose switching flag the test flips directly. */
function controllableGate(): SwitchGate & { switching: boolean } {
  const g = {
    switching: false,
    isSwitching: () => g.switching,
    generation: () => 0,
    trackMutation: () => () => {},
    runExclusive: async <T>(body: () => Promise<T>) => body(),
  };
  return g;
}

let tmp: string;
let ctx: AppContext;
let gate: ReturnType<typeof controllableGate>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'owl-server-gate-'));
  const { db, sqlite } = createDatabase({ dbPath: join(tmp, 'owl.db') });
  const deviceId = ensureDeviceId(db);
  ensureSpecialNotes(db);
  const config = DEFAULT_CONFIG;
  const logger = silentLogger();
  gate = controllableGate();
  ctx = {
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
    switchGate: gate,
  } as AppContext;
});

afterEach(() => {
  ctx.sqlite.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('switch-gate server hook (P5-d Phase 14)', () => {
  it('503 + SWITCH_IN_PROGRESS on a mutating request while switching', async () => {
    gate.switching = true;
    const app = buildTestServer(ctx);
    const res = await app.inject({ method: 'POST', url: '/notes', payload: { content: 'x' } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error_code, 'SWITCH_IN_PROGRESS');
    await app.close();
  });

  it('does not gate GET requests while switching', async () => {
    gate.switching = true;
    const app = buildTestServer(ctx);
    const res = await app.inject({ method: 'GET', url: '/sync/status' });
    assert.notEqual(res.statusCode, 503);
    await app.close();
  });

  it('lets mutating requests through when not switching', async () => {
    gate.switching = false;
    const app = buildTestServer(ctx);
    const res = await app.inject({ method: 'POST', url: '/notes', payload: { content: 'hi' } });
    assert.notEqual(res.statusCode, 503);
    await app.close();
  });
});
