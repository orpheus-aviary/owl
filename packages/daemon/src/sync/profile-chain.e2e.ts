/**
 * P5-d Phase 18 — per-profile model full-chain e2e (design
 * `docs/plans/2026-06-03-phase18-local-full-chain.md`).
 *
 * Where `sync.dual.e2e.ts` exercises the core sync ENGINE in memory, this
 * file exercises the per-profile STORAGE + SWITCH model end-to-end against a
 * real in-process skybridge 0.1.4 server and a real on-disk nest:
 *
 *   toml `[profiles.X]` + `active_profile`  →  core resolver
 *     →  on-disk `profiles/<id>/owl.db`  →  daemon `POST /sync/switch`
 *     →  daemon restart re-resolution  →  quick-switch  →  delete.
 *
 * Upper bound (design Q2): daemon HTTP routes (`/sync/switch`,
 * `/sync/session`, `/sync/run`) against the real server + core
 * resolver/config writers against real toml. The GUI-main orchestration
 * (`loginAndOpenSession` / refresh timer / safeStorage / claim) needs
 * Electron and is covered by unit tests + Phase 19 real-machine smoke — so
 * this e2e performs the *remote* bits GUI main would do (login /
 * registerDevice / ensureWorkspace) directly via the SDK, then feeds the
 * daemon the resulting identity in the production daemon-side order.
 *
 * Two layers of gating, identical to `sync.dual.e2e.ts`:
 *   1. Filename — `.e2e.ts` (no `.test.`), so `just test-daemon`'s
 *      `dist/**\/*.test.js` glob never matches.
 *   2. Runtime — `{ skip: !SKYBRIDGE_E2E }` on the suite.
 *
 * Sequential, not isolated: P2 builds the profile P1 logged into, P3 pushes
 * on it, P4 restarts onto it, etc.
 *
 * `@orpheus-aviary/skybridge-{server,client}` are imported via variable
 * specifiers so `tsc -b` on a clean checkout (SDK uninstalled) still types;
 * the structural module shapes declare only the fields we touch. The
 * client's `login` here returns the richer 0.1.4 `AuthContext`
 * (`serverId`/`refreshToken`/`expiresAt`) — session.ts's `SkybridgeClientModule`
 * omits those because the daemon never logs in.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_CONFIG,
  LOCAL_PROFILE,
  type Logger,
  computeProfileId,
  createDatabase,
  createNote,
  deleteProfileDb,
  ensureDeviceId,
  ensureSpecialNotes,
  isHexProfileId,
  listProfiles,
  paths,
  readEffectiveActiveProfileId,
  removeProfile,
  resolveActiveProfileDbPath,
  setActiveProfile,
  writeProfileConfig,
} from '@owl/core';
import type Database from 'better-sqlite3';

import { ConversationStore } from '../ai/conversations.js';
import { PreviewStore } from '../ai/preview-store.js';
import { createBuiltinRegistry } from '../ai/tools/index.js';
import type { AppContext } from '../context.js';
import { EventsBus } from '../events/bus.js';
import { ReminderScheduler } from '../scheduler.js';
import { buildServer } from '../server.js';
import { stopBackgroundHandles } from './bridge-lifecycle.js';
import { __resetInflightSync, drainManualSync } from './manual.js';
import type { RealSkybridgeClient } from './session.js';
import { createSwitchGate } from './switch-gate.js';

const gate = process.env.SKYBRIDGE_E2E === '1';
const APP_VERSION = 'owl 0.5.0';

// ─── Structural skybridge surfaces (never named in `import`) ─────────

interface SkybridgeServerModule {
  defaultConfig(dir: string): {
    server: { host: string; port: number };
    storage: { dbPath: string; attachmentRoot: string };
    logging: { level: string; file: string | null };
    auth: { tokenByteLength: number };
  };
  openDb(opts: { path: string; requireMigrationsApplied: boolean }): { close(): void };
  applyMigrations(db: unknown): void;
  buildApp(opts: { config: unknown; logger: false }): Promise<{
    app: {
      listen(opts: { host: string; port: number }): Promise<void>;
      close(): Promise<void>;
      server: { address(): { port: number } | string | null };
    };
    db: unknown;
  }>;
  createUser(db: unknown, input: { email: string; password: string }): Promise<{ id: string }>;
}

/** The 0.1.4 `AuthContext` `login` returns (richer than session.ts's type). */
interface E2EAuthContext {
  serverUrl: string;
  token: string;
  user: { id: string; email: string };
  refreshToken?: string;
  expiresAt?: number;
  serverId?: string;
}

interface E2EClientModule {
  CLIENT_VERSION: string;
  login(serverUrl: string, email: string, password: string): Promise<E2EAuthContext>;
  createSkybridgeClient(opts: {
    authContext: E2EAuthContext;
    deviceId?: string;
  }): RealSkybridgeClient;
}

interface E2EServer {
  baseUrl: string;
  serverDb: unknown;
  cleanup: () => Promise<void>;
}

async function startSkybridgeServer(): Promise<{
  server: E2EServer;
  module: SkybridgeServerModule;
}> {
  const spec: string = '@orpheus-aviary/skybridge-server';
  const sb = (await import(spec)) as SkybridgeServerModule;

  const tmp = mkdtempSync(join(tmpdir(), 'profile-chain-e2e-'));
  const config = sb.defaultConfig(tmp);
  config.logging.file = null;
  config.logging.level = 'error';

  const initDb = sb.openDb({ path: config.storage.dbPath, requireMigrationsApplied: false });
  sb.applyMigrations(initDb);
  initDb.close();

  const built = await sb.buildApp({ config, logger: false });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no port from skybridge listen');

  return {
    module: sb,
    server: {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      serverDb: built.db,
      cleanup: async () => {
        await built.app.close();
        rmSync(tmp, { recursive: true, force: true });
      },
    },
  };
}

// ─── ctx factory (mirrors sync.switch.test.ts) ───────────────────────

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

// ─── sqlite probes ───────────────────────────────────────────────────

interface NoteRow {
  id: string;
  content: string;
}

function selectNote(sqlite: Database.Database, id: string): NoteRow | undefined {
  return sqlite.prepare('SELECT id, content FROM notes WHERE id = ?').get(id) as
    | NoteRow
    | undefined;
}

function pendingChangeCount(sqlite: Database.Database): number {
  return (
    sqlite.prepare('SELECT count(*) AS n FROM sync_changes WHERE synced_at IS NULL').get() as {
      n: number;
    }
  ).n;
}

function pushedChangeCount(sqlite: Database.Database): number {
  return (
    sqlite.prepare('SELECT count(*) AS n FROM sync_changes WHERE synced_at IS NOT NULL').get() as {
      n: number;
    }
  ).n;
}

function cursorCount(sqlite: Database.Database): number {
  return (sqlite.prepare('SELECT count(*) AS n FROM sync_cursor').get() as { n: number }).n;
}

function metaValue(sqlite: Database.Database, key: string): string | null {
  const row = sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

/** Open the on-disk local `owl/owl.db` for an isolated probe + close it. */
function probeLocalDb<T>(fn: (sqlite: Database.Database) => T): T {
  const { sqlite } = createDatabase({ dbPath: paths.localProfileDbPath() });
  try {
    return fn(sqlite);
  } finally {
    sqlite.close();
  }
}

// ─── Suite ───────────────────────────────────────────────────────────

describe('per-profile model full-chain e2e (P5-d Phase 18)', { skip: !gate }, () => {
  let server: E2EServer;
  let sb: E2EClientModule;
  let nest: string;
  let priorEnv: string | undefined;
  let ctx: AppContext;
  let app: ReturnType<typeof buildServer>;

  const EMAIL_A = 'a@local';
  const PWD_A = 'password-a-12345';
  const EMAIL_B = 'b@local';
  const PWD_B = 'password-b-12345';

  // Identities filled across the journey.
  type Identity = {
    auth: E2EAuthContext;
    profileId: string;
    device: { id: string; name: string };
    workspace: { id: string; slug: string };
    client: RealSkybridgeClient;
  };
  let A: Identity;
  let B: Identity;
  let localNoteId: string;
  let accountNoteIdA: string;
  let markerNoteIdB: string;

  before(async () => {
    priorEnv = process.env.OWL_NEST_DIR;
    const started = await startSkybridgeServer();
    server = started.server;
    await started.module.createUser(server.serverDb, { email: EMAIL_A, password: PWD_A });

    const clientSpec: string = '@orpheus-aviary/skybridge-client';
    sb = (await import(clientSpec)) as E2EClientModule;

    nest = mkdtempSync(join(tmpdir(), 'owl-profile-chain-'));
    process.env.OWL_NEST_DIR = nest;
    mkdirSync(paths.owlDir(), { recursive: true }); // createDatabase won't mkdir (db/index.ts)

    ctx = makeCtx(resolveActiveProfileDbPath()); // no toml yet → local owl/owl.db
    app = buildServer(ctx);
    await app.ready();
  });

  after(async () => {
    await teardownCtx();
    await server?.cleanup();
    rmSync(nest, { recursive: true, force: true });
    if (priorEnv === undefined) {
      // biome-ignore lint/performance/noDelete: env must be truly unset
      delete process.env.OWL_NEST_DIR;
    } else {
      process.env.OWL_NEST_DIR = priorEnv;
    }
  });

  // Production shutdown order (cli.ts:125-142) + test-only inflight reset.
  async function teardownCtx(): Promise<void> {
    ctx.scheduler.stop();
    stopBackgroundHandles(ctx);
    await drainManualSync();
    await app.close();
    try {
      ctx.sqlite.close();
    } catch {
      // a switch may have already closed the old handle
    }
    __resetInflightSync();
  }

  /** Simulate a daemon restart: tear down, then re-resolve + rebuild. */
  async function restartDaemonCtx(): Promise<void> {
    await teardownCtx();
    ctx = makeCtx(resolveActiveProfileDbPath()); // = cli.ts:66 boot resolution
    app = buildServer(ctx);
    await app.ready();
  }

  /** Remote bootstrap = the bits GUI main does before/around switch. */
  async function loginAndBootstrap(label: string, email: string, pwd: string): Promise<Identity> {
    const auth = await sb.login(server.baseUrl, email, pwd);
    const serverId = auth.serverId;
    assert.ok(serverId, 'R5: a 0.1.4 server must return serverId');
    const profileId = computeProfileId(serverId, auth.user.id);
    assert.ok(isHexProfileId(profileId), 'profileId is 32-hex');

    let client = sb.createSkybridgeClient({ authContext: auth });
    const device = await client.registerDevice({
      name: `e2e-${label}`,
      appVersion: APP_VERSION,
      clientVersion: sb.CLIENT_VERSION,
    });
    client = sb.createSkybridgeClient({ authContext: auth, deviceId: device.id });
    const ws = await client.ensureWorkspace('owl', 'default');

    return {
      auth,
      profileId,
      device,
      workspace: { id: ws.id, slug: ws.slug ?? 'default' },
      client,
    };
  }

  async function postSwitch(profileId: string): Promise<{ device_id: string | null }> {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/switch',
      payload: { profile_id: profileId },
    });
    assert.equal(res.statusCode, 200, `switch ${profileId} → 200`);
    return res.json().data as { device_id: string | null };
  }

  async function postSession(id: Identity): Promise<void> {
    const res = await app.inject({
      method: 'POST',
      url: '/sync/session',
      payload: {
        token: id.auth.token,
        user_id: id.auth.user.id,
        email: id.auth.user.email,
        server_url: server.baseUrl,
        device: { id: id.device.id, name: id.device.name },
        workspace: { id: id.workspace.id, slug: id.workspace.slug },
      },
    });
    assert.equal(res.statusCode, 200, 'session install → 200');
  }

  function writeProfileToml(id: Identity, setActive: boolean): void {
    writeProfileConfig(
      id.profileId,
      {
        server_id: id.auth.serverId,
        server_url: server.baseUrl,
        user_id: id.auth.user.id,
        email: id.auth.user.email,
        encrypted_token: 'e2e-nonsecret-placeholder', // daemon never reads this
        device: {
          id: id.device.id,
          name: id.device.name,
          app_version: APP_VERSION,
          client_version: sb.CLIENT_VERSION,
        },
        workspace: { id: id.workspace.id, slug: id.workspace.slug },
      },
      { setActive },
    );
  }

  // ── P0 ──────────────────────────────────────────────────────────────
  it('P0 — boots on local; resolver → owl/owl.db; seeds a local note', () => {
    assert.equal(
      resolveActiveProfileDbPath(),
      paths.localProfileDbPath(),
      'no toml → resolver returns local owl/owl.db',
    );
    localNoteId = createNote(ctx.db, ctx.sqlite, { content: 'local-only-note' }).id;
    assert.ok(selectNote(ctx.sqlite, localNoteId), 'local note present');
    // Creating a note emits one pending change (synced_at IS NULL) — normal,
    // not contamination. Local is never pushed (asserted in P3).
    assert.ok(pendingChangeCount(ctx.sqlite) >= 1, 'local note produced a pending change');
  });

  // ── P1 ──────────────────────────────────────────────────────────────
  it('P1 — first-login remote bootstrap (A): device + workspace, daemon db untouched', async () => {
    A = await loginAndBootstrap('A', EMAIL_A, PWD_A);
    assert.ok(A.auth.serverId, 'login returned serverId');
    assert.equal(
      resolveActiveProfileDbPath(),
      paths.localProfileDbPath(),
      'daemon still on local before switch',
    );
    assert.equal(existsSync(paths.profileDbPath(A.profileId)), false, 'profile db not yet created');
    assert.ok(selectNote(ctx.sqlite, localNoteId), 'daemon db still holds the local note');
  });

  // ── P2 ──────────────────────────────────────────────────────────────
  it('P2 — switch builds profile db, install session, write toml setActive', async () => {
    const { device_id } = await postSwitch(A.profileId);
    assert.equal(device_id, null, 'fresh profile db has no remembered device');
    assert.ok(existsSync(paths.profileDbPath(A.profileId)), 'profiles/<id>/owl.db created');
    assert.equal(
      selectNote(ctx.sqlite, localNoteId),
      undefined,
      'fresh profile db does not carry the local note (D10b: account ≠ local)',
    );

    await postSession(A);
    writeProfileToml(A, true);

    assert.equal(readEffectiveActiveProfileId(), A.profileId, 'toml active_profile = A');
    const listed = listProfiles();
    assert.equal(listed.length, 1, 'one profile listed');
    assert.equal(listed[0]?.id, A.profileId);
    assert.ok(listed[0]?.dbExists, 'A db exists');
  });

  // ── P3 ──────────────────────────────────────────────────────────────
  it('P3 — push isolation: account note → profile db; local owl.db never synced (D10b)', async () => {
    accountNoteIdA = createNote(ctx.db, ctx.sqlite, { content: 'account-A-note' }).id;

    const run = await app.inject({ method: 'POST', url: '/sync/run' });
    assert.equal(run.statusCode, 200, '/sync/run → 200');
    assert.ok(selectNote(ctx.sqlite, accountNoteIdA), 'account note on profile db');
    assert.equal(pendingChangeCount(ctx.sqlite), 0, 'profile changes all pushed');

    // Server received A's push (under A's workspace).
    const pulled = await A.client.pullChanges(A.workspace.id, 0);
    assert.ok(pulled.changes.length >= 1, 'server change-log has A’s note');

    // D10b: local owl/owl.db is untouched by account sync.
    probeLocalDb((local) => {
      assert.ok(selectNote(local, localNoteId), 'local note intact');
      assert.equal(selectNote(local, accountNoteIdA), undefined, 'account note NOT in local db');
      assert.equal(pushedChangeCount(local), 0, 'local never pushed (no synced_at)');
      assert.equal(cursorCount(local), 0, 'local never pulled (no sync_cursor)');
      assert.equal(metaValue(local, 'skybridge_device_id'), null, 'local has no device binding');
      assert.equal(
        metaValue(local, 'skybridge_workspace_id'),
        null,
        'local has no workspace binding',
      );
    });
  });

  // ── P4 ──────────────────────────────────────────────────────────────
  it('P4 — daemon restart: resolver picks active profile from toml', async () => {
    await restartDaemonCtx();
    assert.equal(
      resolveActiveProfileDbPath(),
      paths.profileDbPath(A.profileId),
      'resolver three-gate → A profile db',
    );
    assert.ok(selectNote(ctx.sqlite, accountNoteIdA), 'profile db has account note after restart');
    assert.equal(selectNote(ctx.sqlite, localNoteId), undefined, 'profile db has no local note');
  });

  // ── P5 ──────────────────────────────────────────────────────────────
  it('P5 — quick-switch to local', async () => {
    await postSwitch(LOCAL_PROFILE);
    setActiveProfile(LOCAL_PROFILE);
    assert.ok(selectNote(ctx.sqlite, localNoteId), 'now on local: local note present');
    assert.equal(
      selectNote(ctx.sqlite, accountNoteIdA),
      undefined,
      'now on local: account note absent',
    );

    await restartDaemonCtx();
    assert.equal(resolveActiveProfileDbPath(), paths.localProfileDbPath(), 'restart → local');
    assert.ok(selectNote(ctx.sqlite, localNoteId), 'local note after restart');
  });

  // ── P6 ──────────────────────────────────────────────────────────────
  it('P6 — quick-switch back to A: device reuse + sync round-trip', async () => {
    const { device_id } = await postSwitch(A.profileId);
    assert.equal(device_id, A.device.id, 'switch returns the remembered device (reuse, §5.3/W4)');
    setActiveProfile(A.profileId);
    assert.ok(selectNote(ctx.sqlite, accountNoteIdA), 'back on A: account note present');

    // Switch cleared ctx.skybridgeSession → reinstall to sync again.
    await postSession(A);
    const run = await app.inject({ method: 'POST', url: '/sync/run' });
    assert.equal(run.statusCode, 200, '/sync/run → 200 after reinstall');

    const devices = await A.client.listDevices();
    assert.equal(devices.length, 1, 'device reused — no proliferation on server');
  });

  // ── P7 ──────────────────────────────────────────────────────────────
  it('P7 — second account (B): coexists; each profile sees only its own notes', async () => {
    // Create B on the already-running server (design: createUser(B) before P7).
    const serverSpec: string = '@orpheus-aviary/skybridge-server';
    const sbServer = (await import(serverSpec)) as SkybridgeServerModule;
    await sbServer.createUser(server.serverDb, { email: EMAIL_B, password: PWD_B });

    B = await loginAndBootstrap('B', EMAIL_B, PWD_B);
    assert.notEqual(B.profileId, A.profileId, 'distinct profile id');

    const { device_id } = await postSwitch(B.profileId);
    assert.equal(device_id, null, 'B is a fresh profile db');
    await postSession(B);
    writeProfileToml(B, true);

    markerNoteIdB = createNote(ctx.db, ctx.sqlite, { content: 'marker-B-note' }).id;
    assert.ok(selectNote(ctx.sqlite, markerNoteIdB), 'B db has its marker note');
    assert.equal(selectNote(ctx.sqlite, accountNoteIdA), undefined, 'B db does not see A’s note');

    const listed = listProfiles()
      .map((p) => p.id)
      .sort();
    assert.deepEqual(listed, [A.profileId, B.profileId].sort(), 'both profiles listed');

    // Switch back to A — A sees only A's note.
    await postSwitch(A.profileId);
    setActiveProfile(A.profileId);
    assert.ok(selectNote(ctx.sqlite, accountNoteIdA), 'back on A: A note present');
    assert.equal(selectNote(ctx.sqlite, markerNoteIdB), undefined, 'A db does not see B’s marker');
  });

  // ── P8 ──────────────────────────────────────────────────────────────
  it('P8 — delete A local copy: B + local intact; ghost not revived (P9 folded)', async () => {
    // We're on A (P7 ended there). Release the handle by switching to local.
    await postSwitch(LOCAL_PROFILE);
    setActiveProfile(LOCAL_PROFILE);

    deleteProfileDb(A.profileId);
    removeProfile(A.profileId);

    assert.equal(existsSync(paths.profileDbPath(A.profileId)), false, 'A db deleted');
    assert.equal(existsSync(`${paths.profileDbPath(A.profileId)}-wal`), false, 'A wal deleted');
    assert.equal(existsSync(`${paths.profileDbPath(A.profileId)}-shm`), false, 'A shm deleted');

    const listed = listProfiles().map((p) => p.id);
    assert.ok(!listed.includes(A.profileId), 'A no longer listed');
    assert.ok(listed.includes(B.profileId), 'sibling B not deleted');
    assert.ok(existsSync(paths.profileDbPath(B.profileId)), 'B db intact');

    // Ghost defense (P9): resolver falls back to local, does not revive A.
    assert.equal(readEffectiveActiveProfileId(), LOCAL_PROFILE, 'active = local after delete');

    probeLocalDb((local) => {
      assert.ok(selectNote(local, localNoteId), 'local owl.db untouched');
    });
  });
});
