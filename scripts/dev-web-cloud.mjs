#!/usr/bin/env node
// ④ web session UX — persistent local web-cloud rig for MANUAL browser testing.
//
// One Node process hosts BOTH halves of the cloud stack (exactly the shape the
// `cloud-auth.skybridge.e2e.ts` proves, but real-listening + resident):
//   - an in-process skybridge server (real HTTP listen, random port)
//   - the owl cloud daemon via the production `boot({ resolveConfig })` entry,
//     listening on 127.0.0.1:47020 and same-origin hosting `apps/web/dist`
//     (`[daemon].web_root`) under the strict CSP.
//
// The browser only ever talks to the daemon (same origin); the daemon talks to
// skybridge server-side, so the skybridge port stays internal.
//
// Run via `just dev-web-cloud` (ensures Node ABI + builds + a fresh /tmp nest).
// Ctrl-C tears everything down (both servers share this process).
//
// Login in the browser as the OWNER printed below. A second account is created
// for logout→login-other-account (cross-account) checks — but the daemon's
// `account_lock` only admits the owner, so the second account is for verifying
// the 403 lock path, not a full second session. For a genuine "switch accounts"
// test on the web host, log out and back in as the owner (same-account re-login
// still re-bootstraps).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = resolve(repoRoot, 'apps/web/dist');
const DAEMON_PORT = Number(process.env.OWL_DAEMON_PORT ?? 47020);

const OWNER = { email: 'owner@x.test', password: 'longenoughpw' };
const SECOND = { email: 'second@x.test', password: 'longenoughpw' };

const SEED_NOTES = [
  '# 欢迎 — owl web rig\n\n这是账号 **owner@x.test** 的笔记，用来验证登录后内容渲染与「不串号」。\n\n- 行内公式：$e^{i\\pi}+1=0$\n- 代码高亮：\n\n```ts\nconst hi = (name: string) => `hello ${name}`;\n```\n',
  '# 第二篇\n\n刷新后应停留在当前视图（deep-link 保留）。\n\n$$\\int_0^1 x^2\\,dx = \\tfrac13$$\n',
];

async function main() {
  // ── 1) In-process skybridge server (real listen, random port) ──────────
  const sb = await import('@orpheus-aviary/skybridge-server');
  const sbTmp = mkdtempSync(join(tmpdir(), 'owl-web-rig-sb-'));
  const sbConfig = sb.defaultConfig(sbTmp);
  sbConfig.logging.file = null;
  sbConfig.logging.level = 'error';
  const initDb = sb.openDb({ path: sbConfig.storage.dbPath, requireMigrationsApplied: false });
  sb.applyMigrations(initDb);
  initDb.close();
  const built = await sb.buildApp({ config: sbConfig, logger: false });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr !== 'object') throw new Error('skybridge: no port from listen');
  const serverUrl = `http://127.0.0.1:${addr.port}`;
  await sb.createUser(built.db, OWNER);
  await sb.createUser(built.db, SECOND);
  console.log(`[rig] skybridge up at ${serverUrl} (users: ${OWNER.email}, ${SECOND.email})`);

  // Deep-import the built dist files by path: `@owl/daemon` / `@owl/core` are
  // workspace packages with no root node_modules symlink, so bare-specifier
  // import fails from a repo-root script. The dist's OWN imports still resolve
  // against packages/{daemon,core}/node_modules.
  const daemonUrl = new URL('../packages/daemon/dist/index.js', import.meta.url).href;
  const coreUrl = new URL('../packages/core/dist/index.js', import.meta.url).href;

  // ── 2) Owner profileId (one-shot login, real SDK — same as compute-owner) ─
  const { boot, computeOwnerProfileId } = await import(daemonUrl);
  const ownerProfileId = await computeOwnerProfileId({ serverUrl, ...OWNER });
  console.log(`[rig] owner profileId = ${ownerProfileId}`);

  // ── 3) Cloud daemon config with same-origin web_root ───────────────────
  const { DEFAULT_CONFIG } = await import(coreUrl);
  const config = {
    ...structuredClone(DEFAULT_CONFIG),
    daemon: {
      ...DEFAULT_CONFIG.daemon,
      mode: 'cloud',
      bind: '127.0.0.1',
      port: DAEMON_PORT,
      server_url: serverUrl,
      account_lock: ownerProfileId,
      public_url: `http://127.0.0.1:${DAEMON_PORT}`,
      web_root: WEB_ROOT,
    },
    sync: { interval_min: 0 }, // no background sync timer for the rig
  };

  // ── 4) Boot the owl daemon (real listen + serves the shell). Resident. ──
  await boot({ resolveConfig: () => config });

  // ── 5) Seed a couple of owner notes (best-effort) ──────────────────────
  await seedNotes(`http://127.0.0.1:${DAEMON_PORT}`).catch((err) =>
    console.warn(`[rig] note seeding skipped: ${err?.message ?? err}`),
  );

  const url = `http://127.0.0.1:${DAEMON_PORT}`;
  const bar = '='.repeat(64);
  console.log(`\n${bar}`);
  console.log(`  ✅ owl web rig ready → open  ${url}`);
  console.log(`     login: ${OWNER.email} / ${OWNER.password}`);
  console.log('     Ctrl-C to stop (tears down both servers).');
  console.log(`${bar}\n`);
}

async function seedNotes(base) {
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(OWNER),
  });
  const token = (await login.json())?.data?.session_token;
  if (!token) throw new Error('login returned no token');
  for (const content of SEED_NOTES) {
    await fetch(`${base}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
    });
  }
  console.log(`[rig] seeded ${SEED_NOTES.length} owner notes`);
}

main().catch((err) => {
  console.error('[rig] failed to start:', err);
  process.exit(1);
});
