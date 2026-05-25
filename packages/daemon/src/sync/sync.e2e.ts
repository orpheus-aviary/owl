/**
 * P5-a Step 7 — end-to-end sync round-trip against an in-process
 * skybridge server.
 *
 * Two layers of gating:
 *   1. Filename — `sync.e2e.ts` (no `.test.`), so default
 *      `node --test 'dist/**\/*.test.js'` glob does NOT match. CI / `just
 *      test-daemon` runs daemon's regular unit tests without ever loading
 *      this file.
 *   2. Runtime — `{ skip: !SKYBRIDGE_E2E }` on the top-level suite.
 *      If someone manually runs `node --test 'dist/**\/*.e2e.js'` without
 *      setting the env, the suite still skips.
 *
 * The `@orpheus-aviary/skybridge-server` import uses a variable specifier
 * so TypeScript does not statically resolve the module. The package is
 * installed as a normal devDependency of daemon (since 0.4.2) so the
 * runtime import succeeds; the variable-specifier pattern remains for
 * symmetry with the production session.ts path and to keep the
 * SKYBRIDGE_NOT_INSTALLED branch reachable if the dep is ever stripped.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const gate = process.env.SKYBRIDGE_E2E === '1';

// Structural shape of @orpheus-aviary/skybridge-server. NOT imported as a type — the
// package may be absent on a clean checkout.
interface SkybridgeServerModule {
  defaultConfig(dir: string): {
    storage: { dbPath: string };
    logging: { level: string; file: string | null };
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
  createUser(db: unknown, input: { email: string; password: string }): Promise<unknown>;
}

interface E2EHandle {
  baseUrl: string;
  cleanup: () => Promise<void>;
}

describe('sync e2e (in-process skybridge)', { skip: !gate }, () => {
  let server: E2EHandle;

  before(async () => {
    const spec: string = '@orpheus-aviary/skybridge-server';
    const sb = (await import(spec)) as SkybridgeServerModule;
    const tmp = mkdtempSync(join(tmpdir(), 'sync-e2e-'));
    const config = sb.defaultConfig(tmp);
    config.logging.file = null;
    config.logging.level = 'error';

    // Migration on a fresh DB
    const initDb = sb.openDb({
      path: config.storage.dbPath,
      requireMigrationsApplied: false,
    });
    sb.applyMigrations(initDb);
    initDb.close();

    const built = await sb.buildApp({ config, logger: false });
    await built.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = built.app.server.address();
    if (!addr || typeof addr !== 'object') throw new Error('no port from skybridge listen');

    await sb.createUser(built.db, { email: 'jay@x.test', password: 'longenoughpw' });

    server = {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      cleanup: async () => {
        await built.app.close();
        rmSync(tmp, { recursive: true, force: true });
      },
    };
  });

  after(async () => {
    if (server) await server.cleanup();
  });

  it('server bootstrap surface is present', () => {
    // Sanity check while the broader e2e cases are filled in by Step 7d
    // follow-ups (each requires a live owl daemon + per-suite owl.db).
    assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
