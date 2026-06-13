/**
 * Phase A (A2) — auth preHandler integration tests.
 *
 * Builds real servers (cloud + local) and drives them via inject. buildServer
 * does NOT run the A0 startup guard, so a cloud ctx can be assembled directly.
 * The session store is created by ensureSessionStore inside buildServer and
 * surfaced on ctx, so tests mint tokens through ctx.sessionStore.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type OwlConfig,
  type OwlDatabase,
  createConsoleLogger,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
} from '@owl/core';
import type Database from 'better-sqlite3';
import { ConversationStore } from './ai/conversations.js';
import { PreviewStore } from './ai/preview-store.js';
import { createBuiltinRegistry } from './ai/tools/index.js';
import type { AppContext } from './context.js';
import { EventsBus } from './events/bus.js';
import { ReminderScheduler } from './scheduler.js';
import { buildServer } from './server.js';

function cloudConfig(): OwlConfig {
  return {
    ...DEFAULT_CONFIG,
    daemon: {
      ...DEFAULT_CONFIG.daemon,
      mode: 'cloud',
      server_url: 'http://127.0.0.1:18443',
      account_lock: 'off',
      public_url: 'http://127.0.0.1:47010',
    },
  };
}

function buildCtx(config: OwlConfig): {
  ctx: AppContext;
  db: OwlDatabase;
  sqlite: Database.Database;
  scheduler: ReminderScheduler;
} {
  const { db, sqlite } = createDatabase({ dbPath: ':memory:' });
  ensureSpecialNotes(db);
  const logger = createConsoleLogger('auth-test', 'silent');
  const scheduler = new ReminderScheduler(db, sqlite, config, logger);
  const ctx: AppContext = {
    db,
    sqlite,
    config,
    logger,
    deviceId: ensureDeviceId(db),
    scheduler,
    toolRegistry: createBuiltinRegistry(),
    conversationStore: new ConversationStore(sqlite),
    previewStore: new PreviewStore(),
    eventsBus: new EventsBus(),
    skybridgeSession: null,
  };
  return { ctx, db, sqlite, scheduler };
}

describe('auth preHandler — cloud mode', () => {
  it('allows the public allowlist without a bearer (GET /status)', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/status' });
    assert.equal(res.statusCode, 200);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('treats POST /auth/login as public (404 not-yet-registered, not 401)', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: {} });
    assert.equal(res.statusCode, 404); // route lands in A4; preHandler must not 401 it
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('401 SESSION_REQUIRED when a protected route gets no bearer', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/notes' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error_code, 'SESSION_REQUIRED');
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('401 SESSION_INVALID for a bogus bearer', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().error_code, 'SESSION_INVALID');
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('passes with a freshly-minted session bearer', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig());
    const app = buildServer(ctx);
    await app.ready();
    assert.ok(ctx.sessionStore, 'ensureSessionStore should populate ctx.sessionStore');
    const { token } = ctx.sessionStore.mint('owner-profile');
    const res = await app.inject({
      method: 'GET',
      url: '/notes',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.statusCode, 200);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });
});

describe('auth preHandler — local mode (no-op, desktop unchanged)', () => {
  it('allows protected routes with no bearer', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(structuredClone(DEFAULT_CONFIG));
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/notes' });
    assert.equal(res.statusCode, 200);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });
});
