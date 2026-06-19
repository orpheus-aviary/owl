/**
 * Phase B4 — web hosting: path resolution / validation, static serving + CSP,
 * the cloud auth-gate static bypass, and a route-coverage guard asserting every
 * registered daemon route is covered by API_PREFIXES (so none leaks as public).
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { isApiPath } from '@orpheus-aviary/owl-shared/api-paths';
import {
  DEFAULT_CONFIG,
  type OwlConfig,
  createConsoleLogger,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
} from '@owl/core';
import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import { ConversationStore } from './ai/conversations.js';
import { PreviewStore } from './ai/preview-store.js';
import { createBuiltinRegistry } from './ai/tools/index.js';
import { isPublicPath } from './auth.js';
import type { AppContext } from './context.js';
import { EventsBus } from './events/bus.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerConflictsRoutes } from './routes/conflicts.js';
import { registerEventsRoutes } from './routes/events.js';
import { registerFolderRoutes } from './routes/folders.js';
import { registerNoteRoutes } from './routes/notes.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerTagRoutes } from './routes/tags.js';
import { registerTodoRoutes } from './routes/todos.js';
import { ReminderScheduler } from './scheduler.js';
import { buildServer } from './server.js';
import { assertWebRootValid, resolveWebRoot } from './web-host.js';

// ── a throwaway web bundle (index.html + one asset) ─────────────────────
const webDir = mkdtempSync(join(tmpdir(), 'owl-b4-web-'));
mkdirSync(join(webDir, 'assets'));
writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>owl</title>');
writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log("owl")');
after(() => rmSync(webDir, { recursive: true, force: true }));

function buildCtx(config: OwlConfig): {
  ctx: AppContext;
  sqlite: Database.Database;
  scheduler: ReminderScheduler;
} {
  const { db, sqlite } = createDatabase({ dbPath: ':memory:' });
  ensureSpecialNotes(db);
  const logger = createConsoleLogger('web-host-test', 'silent');
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
  return { ctx, sqlite, scheduler };
}

function localConfig(web_root?: string): OwlConfig {
  return { ...DEFAULT_CONFIG, daemon: { ...DEFAULT_CONFIG.daemon, web_root } };
}

function cloudConfig(web_root?: string): OwlConfig {
  return {
    ...DEFAULT_CONFIG,
    daemon: {
      ...DEFAULT_CONFIG.daemon,
      mode: 'cloud',
      server_url: 'http://127.0.0.1:18443',
      account_lock: 'off',
      public_url: 'http://127.0.0.1:47010',
      web_root,
    },
  };
}

describe('resolveWebRoot', () => {
  it('returns undefined when web_root is unset', () => {
    assert.equal(resolveWebRoot(localConfig()), undefined);
  });

  it('returns an absolute web_root unchanged', () => {
    assert.equal(resolveWebRoot(localConfig('/srv/owl/web')), '/srv/owl/web');
  });

  it('resolves a relative web_root against the nest dir (not cwd)', () => {
    const prev = process.env.OWL_NEST_DIR;
    process.env.OWL_NEST_DIR = '/tmp/owl-nest';
    try {
      assert.equal(resolveWebRoot(localConfig('web/dist')), '/tmp/owl-nest/web/dist');
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'OWL_NEST_DIR');
      else process.env.OWL_NEST_DIR = prev;
    }
  });
});

describe('assertWebRootValid', () => {
  it('no-ops when unset', () => {
    assert.doesNotThrow(() => assertWebRootValid(undefined));
  });

  it('passes for a directory containing index.html', () => {
    assert.doesNotThrow(() => assertWebRootValid(webDir));
  });

  it('throws DaemonStartupError for a missing path', () => {
    assert.throws(() => assertWebRootValid(join(webDir, 'nope')), /web_root.*index\.html/);
  });

  it('throws when index.html is absent', () => {
    const empty = mkdtempSync(join(tmpdir(), 'owl-b4-empty-'));
    try {
      assert.throws(() => assertWebRootValid(empty), /index\.html/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('static hosting (local mode)', () => {
  it('serves index.html at / and assets, 404s missing files, leaves API 404 untouched', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(localConfig(webDir));
    const app = buildServer(ctx);
    await app.ready();

    const index = await app.inject({ method: 'GET', url: '/' });
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /owl/);

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    assert.equal(asset.statusCode, 200);

    const missingAsset = await app.inject({ method: 'GET', url: '/assets/missing.js' });
    assert.equal(missingAsset.statusCode, 404);
    // NOT the SPA index — a missing asset must stay a real 404.
    assert.doesNotMatch(missingAsset.body, /<!doctype html>/i);

    // Unmatched API GET keeps Fastify's default 404 (wildcard:false didn't shadow it).
    const apiMiss = await app.inject({ method: 'GET', url: '/notes/a/b/c' });
    assert.equal(apiMiss.statusCode, 404);
    assert.doesNotMatch(apiMiss.body, /<!doctype html>/i);

    // CSP + hardening headers are stamped on served responses.
    assert.match(index.headers['content-security-policy'] as string, /default-src 'self'/);
    assert.equal(index.headers['x-content-type-options'], 'nosniff');

    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  it('does not register static / CSP when web_root is unset', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(localConfig());
    const app = buildServer(ctx);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/' });
    assert.equal(res.statusCode, 404); // no static route
    assert.equal(res.headers['content-security-policy'], undefined);
    scheduler.stop();
    await app.close();
    sqlite.close();
  });
});

describe('cloud auth gate — static shell is public, API stays bearer-gated', () => {
  it('serves / and /assets/* without a bearer but 401s API + non-API writes', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(cloudConfig(webDir));
    const app = buildServer(ctx);
    await app.ready();

    const shell = await app.inject({ method: 'GET', url: '/' });
    assert.equal(shell.statusCode, 200, 'web shell is public');

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    assert.equal(asset.statusCode, 200, 'assets are public');

    const api = await app.inject({ method: 'GET', url: '/notes' });
    assert.equal(api.statusCode, 401, 'API still needs a bearer');

    // A non-API write (outside API_PREFIXES) is fail-closed, not public.
    const write = await app.inject({ method: 'POST', url: '/not-an-api', payload: {} });
    assert.equal(write.statusCode, 401, 'non-API non-GET stays bearer-gated');

    scheduler.stop();
    await app.close();
    sqlite.close();
  });
});

describe('route coverage — every registered route is under API_PREFIXES', () => {
  it('no daemon API route escapes the auth gate as a public path', async () => {
    const { ctx, sqlite, scheduler } = buildCtx(localConfig());
    const urls = new Set<string>();
    const app = Fastify({ logger: false });
    app.addHook('onRoute', (r) => {
      urls.add(r.url);
    });
    registerNoteRoutes(app, ctx);
    registerFolderRoutes(app, ctx);
    registerTagRoutes(app, ctx);
    registerTodoRoutes(app, ctx);
    registerConfigRoutes(app, ctx);
    registerAiRoutes(app, ctx);
    registerAuthRoutes(app, ctx);
    registerSystemRoutes(app);
    registerEventsRoutes(app, ctx);
    registerSyncRoutes(app, ctx);
    registerConflictsRoutes(app, ctx);
    await app.ready();

    for (const url of urls) {
      const covered = isApiPath(url) || isPublicPath('GET', url) || isPublicPath('POST', url);
      assert.ok(covered, `route ${url} is not covered by API_PREFIXES — it would be public`);
    }

    await app.close();
    scheduler.stop();
    sqlite.close();
  });
});
