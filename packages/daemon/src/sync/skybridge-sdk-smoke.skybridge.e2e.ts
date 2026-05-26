import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * P5-d Phase 4 — SDK / daemon fixture smoke.
 *
 * Validates that `@orpheus-aviary/skybridge-client@0.1.3`'s three new
 * additive APIs work in owl's runtime environment, against a real
 * `@orpheus-aviary/skybridge-server@0.1.3` spawned in-process:
 *
 *   1. `client.logout()` — revokes current token, subsequent authed call 401s
 *   2. `client.listDevices()` — returns the user's device(s) with correct shape
 *   3. `subscribeEvents({ onFrame })` — fires for `:ok` comment + `event: ping`
 *      + `event: change` frames (where owl's SSE idle watchdog will hook in
 *      during Phase 11)
 *
 * Gated on filename `*.skybridge.e2e.ts` so this file is only picked up by
 * `just test-skybridge-e2e`. SKYBRIDGE_E2E=1 belt-and-suspenders so a stray
 * direct `node --test` invocation skips cleanly.
 *
 * Not a full daemon round-trip — that's covered by sync.dual.e2e.ts. This
 * file's job is narrow: prove the new SDK surface lights up over the wire.
 */

const gate = process.env.SKYBRIDGE_E2E === '1';

interface SkybridgeServerModule {
  defaultConfig(dir: string): {
    server: { host: string; port: number };
    storage: { dbPath: string; attachmentRoot: string };
    logging: { level: string; file: string | null };
    auth: { tokenByteLength: number };
  };
  openDb(opts: { path: string; requireMigrationsApplied: boolean }): { close(): void };
  applyMigrations(db: unknown): void;
  buildApp(opts: {
    config: unknown;
    logger: false;
    sse?: { pingIntervalMs?: number };
  }): Promise<{
    app: {
      listen(opts: { host: string; port: number }): Promise<void>;
      close(): Promise<void>;
      server: { address(): { port: number } | string | null };
    };
    db: unknown;
  }>;
  createUser(db: unknown, input: { email: string; password: string }): Promise<{ id: string }>;
}

interface SseFrameLike {
  event: string;
  data: string;
  id?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: ad-hoc structural surface for smoke only
type SkybridgeClient = any;

interface E2EServer {
  baseUrl: string;
  serverDb: unknown;
  module: SkybridgeServerModule;
  cleanup: () => Promise<void>;
}

// Short ping cadence so the onFrame ping observation finishes fast.
const SSE_PING_MS = 80;

async function startServer(): Promise<E2EServer> {
  const spec: string = '@orpheus-aviary/skybridge-server';
  // biome-ignore lint/suspicious/noExplicitAny: gated dynamic import
  const sb = (await import(spec)) as any as SkybridgeServerModule;

  const tmp = mkdtempSync(join(tmpdir(), 'sdk-smoke-'));
  const config = sb.defaultConfig(tmp);
  config.logging.file = null;
  config.logging.level = 'error';

  const initDb = sb.openDb({ path: config.storage.dbPath, requireMigrationsApplied: false });
  sb.applyMigrations(initDb);
  initDb.close();

  const built = await sb.buildApp({
    config,
    logger: false,
    sse: { pingIntervalMs: SSE_PING_MS },
  });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no port from skybridge listen');

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    serverDb: built.db,
    module: sb,
    cleanup: async () => {
      await built.app.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe('skybridge client 0.1.3 SDK smoke (owl-side P5-d Phase 4)', { skip: !gate }, () => {
  let server: E2EServer;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic-import SDK module
  let sb: any;

  before(async () => {
    server = await startServer();
    const spec: string = '@orpheus-aviary/skybridge-client';
    sb = await import(spec);
    await server.module.createUser(server.serverDb, {
      email: 'sdk-smoke@example.test',
      password: 'pw-smoke-test',
    });
  });

  after(async () => {
    await server.cleanup();
  });

  it('listDevices() returns registered device with expected shape', async () => {
    const auth = await sb.login(server.baseUrl, 'sdk-smoke@example.test', 'pw-smoke-test');
    let client: SkybridgeClient = sb.createSkybridgeClient({ authContext: auth });

    // Empty before register.
    const empty = await client.listDevices();
    assert.deepEqual(empty, []);

    const device = await client.registerDevice({
      name: 'smoke-mac',
      platform: 'darwin',
      appVersion: '0.5.0-dev',
      clientVersion: sb.CLIENT_VERSION,
    });
    assert.ok(device.id, 'registerDevice returns id');

    // Rebuild client with deviceId so subsequent calls carry X-Device-Id.
    client = sb.createSkybridgeClient({ authContext: auth, deviceId: device.id });

    const after = (await client.listDevices()) as Array<{
      id: string;
      name: string;
      platform: string | null;
      appVersion: string | null;
      clientVersion: string | null;
      createdAt: number;
      lastSeenAt: number;
    }>;
    assert.equal(after.length, 1);
    const row = after[0];
    if (!row) throw new Error('listDevices returned empty');
    assert.equal(row.id, device.id);
    assert.equal(row.name, 'smoke-mac');
    assert.equal(row.platform, 'darwin');
    assert.equal(row.appVersion, '0.5.0-dev');
    assert.equal(row.clientVersion, sb.CLIENT_VERSION);
    assert.ok(typeof row.createdAt === 'number');
    assert.ok(typeof row.lastSeenAt === 'number');
  });

  it('logout() revokes token; subsequent authed call 401s', async () => {
    const auth = await sb.login(server.baseUrl, 'sdk-smoke@example.test', 'pw-smoke-test');
    const preLogoutClient: SkybridgeClient = sb.createSkybridgeClient({ authContext: auth });

    // Sanity: token works pre-logout.
    await preLogoutClient.listDevices();

    await preLogoutClient.logout();

    // Same token → 401 TOKEN_INVALID (server revoked it).
    let err: unknown;
    try {
      await preLogoutClient.listDevices();
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'listDevices after logout should reject');
    const apiErr = err as { name?: string; status?: number; code?: string };
    assert.equal(apiErr.name, 'ApiError');
    assert.equal(apiErr.status, 401);
    assert.equal(apiErr.code, 'TOKEN_INVALID');
  });

  it('subscribeEvents onFrame fires for :ok comment + ping + change frames', async () => {
    const auth = await sb.login(server.baseUrl, 'sdk-smoke@example.test', 'pw-smoke-test');
    let client: SkybridgeClient = sb.createSkybridgeClient({ authContext: auth });
    const device = await client.registerDevice({
      name: 'smoke-sse',
      platform: 'darwin',
      appVersion: '0.5.0-dev',
      clientVersion: sb.CLIENT_VERSION,
    });
    client = sb.createSkybridgeClient({ authContext: auth, deviceId: device.id });
    const ws = await client.ensureWorkspace('owl', `smoke-${Date.now()}`);

    const frames: SseFrameLike[] = [];
    const changes: number[] = [];
    let opened = false;
    let lastError: Error | null = null;

    const unsubscribe = client.subscribeEvents(ws.id, {
      onChange: (seq: number) => changes.push(seq),
      onFrame: (frame: SseFrameLike) =>
        frames.push({
          event: frame.event,
          data: frame.data,
          ...(frame.id ? { id: frame.id } : {}),
        }),
      onOpen: () => {
        opened = true;
      },
      onError: (err: Error) => {
        lastError = err;
      },
    });

    // Wait for onOpen + initial `:ok` frame + at least one ping
    // (server pings every SSE_PING_MS ≈ 80ms, so 250ms easily covers).
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(opened, 'onOpen fired');
    assert.equal(lastError, null, 'no error during smoke');

    // Initial frame is the synthetic `comment` from `:ok\n\n`.
    assert.equal(frames[0]?.event, 'comment', 'first frame is :ok synthetic comment');
    assert.ok(
      frames.some((f) => f.event === 'ping'),
      'at least one ping frame observed',
    );

    // Trigger a change frame: push a no-op via the SDK.
    // The simplest server-emitted change is a pushChanges round.
    await client.pushChanges(ws.id, [
      {
        clientChangeId: 'cc-smoke-1',
        entityType: 'note',
        entityId: 'n-smoke',
        op: 'put',
        payload: JSON.stringify({ id: 'n-smoke', title: 'x' }),
        clientLocalSeq: 1,
        clientCreatedAt: Date.now(),
      },
    ]);

    await new Promise((r) => setTimeout(r, 200));
    assert.ok(
      frames.some((f) => f.event === 'change'),
      'change frame observed via onFrame',
    );
    assert.equal(changes.length, 1, 'onChange fired exactly once');

    unsubscribe();
  });
});
