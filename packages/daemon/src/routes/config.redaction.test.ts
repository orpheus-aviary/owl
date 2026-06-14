/**
 * Phase A (A5) — GET/PATCH /config secret redaction + llm owner-gate.
 *
 * Builds a real server via inject (buildServer skips the A0 startup guard, so a
 * cloud ctx is assembled directly). Layer-2 sessions are minted straight on
 * ctx.sessionStore — no login chain needed, since redaction only reads
 * req.session.profileId vs account_lock. A temp configPath catches PATCH's
 * saveConfig so it never touches the real nest.
 *
 * Design: docs/plans/2026-06-12-phase-a-cloud-daemon-design.md §6.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type OwlConfig,
  createConsoleLogger,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
} from '@owl/core';
import type Database from 'better-sqlite3';
import { ConversationStore } from '../ai/conversations.js';
import { PreviewStore } from '../ai/preview-store.js';
import { createBuiltinRegistry } from '../ai/tools/index.js';
import type { AppContext } from '../context.js';
import { EventsBus } from '../events/bus.js';
import { ReminderScheduler } from '../scheduler.js';
import { buildServer } from '../server.js';

const OWNER = 'owner-profile';
const SECRET = 'sk-super-secret';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'owl-a5-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function cloudConfig(accountLock: string, apiKey = SECRET): OwlConfig {
  return {
    ...DEFAULT_CONFIG,
    llm: { ...DEFAULT_CONFIG.llm, api_key: apiKey },
    daemon: {
      ...DEFAULT_CONFIG.daemon,
      mode: 'cloud',
      server_url: 'http://127.0.0.1:18443',
      account_lock: accountLock,
      public_url: 'http://127.0.0.1:47010',
    },
  };
}

function localConfig(apiKey = SECRET): OwlConfig {
  return { ...DEFAULT_CONFIG, llm: { ...DEFAULT_CONFIG.llm, api_key: apiKey } };
}

function buildCtx(config: OwlConfig): {
  ctx: AppContext;
  sqlite: Database.Database;
  scheduler: ReminderScheduler;
} {
  const { db, sqlite } = createDatabase({ dbPath: ':memory:' });
  ensureSpecialNotes(db);
  const logger = createConsoleLogger('a5-test', 'silent');
  const scheduler = new ReminderScheduler(db, sqlite, config, logger);
  const ctx: AppContext = {
    db,
    sqlite,
    config,
    configPath: join(tmp, 'owl_config.toml'),
    logger,
    deviceId: ensureDeviceId(db),
    scheduler,
    toolRegistry: createBuiltinRegistry(),
    conversationStore: new ConversationStore(sqlite),
    previewStore: new PreviewStore(),
    eventsBus: new EventsBus(),
    skybridgeSession: null,
  };
  return { ctx, sqlite, scheduler };
}

/** Mint a session, GET/PATCH /config with its bearer, return the parsed reply. */
function bearer(token?: string): { authorization: string } | undefined {
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

describe('GET /config — secret redaction (A5)', () => {
  it('cloud owner session sees the full config incl. api_key', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig(OWNER));
    const app = buildServer(ctx);
    await app.ready();
    const { token } = ctx.sessionStore!.mint(OWNER);
    const res = await app.inject({ method: 'GET', url: '/config', headers: bearer(token) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.llm.api_key, SECRET);
    assert.equal(res.json().data.llm.has_api_key, undefined);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('cloud non-owner session gets the redacted projection (no api_key)', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig(OWNER));
    const app = buildServer(ctx);
    await app.ready();
    const { token } = ctx.sessionStore!.mint('intruder-profile');
    const res = await app.inject({ method: 'GET', url: '/config', headers: bearer(token) });
    assert.equal(res.statusCode, 200);
    const llm = res.json().data.llm;
    assert.equal(llm.api_key, undefined, 'api_key must be stripped');
    assert.equal(llm.has_api_key, true, 'has_api_key flags the present (hidden) key');
    // Non-secret fields still flow through.
    assert.equal(res.json().data.daemon.public_url, 'http://127.0.0.1:47010');
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('cloud off mode redacts for any session (no fixed owner)', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig('off'));
    const app = buildServer(ctx);
    await app.ready();
    const { token } = ctx.sessionStore!.mint('whoever-profile');
    const res = await app.inject({ method: 'GET', url: '/config', headers: bearer(token) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.llm.api_key, undefined);
    assert.equal(res.json().data.llm.has_api_key, true);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('has_api_key is false when the projected key is empty', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig('off', ''));
    const app = buildServer(ctx);
    await app.ready();
    const { token } = ctx.sessionStore!.mint('whoever-profile');
    const res = await app.inject({ method: 'GET', url: '/config', headers: bearer(token) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.llm.has_api_key, false);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('local mode always returns the full config (no Layer-2, desktop unchanged)', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(localConfig());
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/config' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.llm.api_key, SECRET);
    assert.equal(res.json().data.llm.has_api_key, undefined);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });
});

describe('PATCH /config — llm owner-gate (A5)', () => {
  it('cloud non-owner cannot patch llm.* (403, config untouched)', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig(OWNER));
    const app = buildServer(ctx);
    await app.ready();
    const { token } = ctx.sessionStore!.mint('intruder-profile');
    const res = await app.inject({
      method: 'PATCH',
      url: '/config',
      headers: bearer(token),
      payload: { llm: { api_key: 'sk-evil' } },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error_code, 'FORBIDDEN');
    assert.equal(ctx.config.llm.api_key, SECRET, 'key must be unchanged');
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('cloud owner can patch llm.* and sees the full response', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig(OWNER));
    const app = buildServer(ctx);
    await app.ready();
    const { token } = ctx.sessionStore!.mint(OWNER);
    const res = await app.inject({
      method: 'PATCH',
      url: '/config',
      headers: bearer(token),
      payload: { llm: { model: 'gpt-x' } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.llm.model, 'gpt-x');
    assert.equal(res.json().data.llm.api_key, SECRET, 'owner sees the key in the response');
    assert.equal(ctx.config.llm.model, 'gpt-x');
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('cloud non-owner CAN patch a non-llm section; response is redacted', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig(OWNER));
    const app = buildServer(ctx);
    await app.ready();
    const { token } = ctx.sessionStore!.mint('intruder-profile');
    const res = await app.inject({
      method: 'PATCH',
      url: '/config',
      headers: bearer(token),
      payload: { font: { editor_font_size: 18 } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.font.editor_font_size, 18);
    assert.equal(res.json().data.llm.api_key, undefined, 'response still redacts the key');
    assert.equal(res.json().data.llm.has_api_key, true);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('local mode can patch llm.* (owner by definition)', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(localConfig());
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({
      method: 'PATCH',
      url: '/config',
      payload: { llm: { model: 'local-model' } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().data.llm.model, 'local-model');
    assert.equal(res.json().data.llm.api_key, SECRET);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });
});
