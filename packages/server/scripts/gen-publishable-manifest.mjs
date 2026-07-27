#!/usr/bin/env node
/**
 * Post-tsup build step for @owl/server. Writes dist/package.json under the
 * publish name @orpheus-aviary/owl-server, embeds the web bundle + core
 * migrations + sample config, and copies LICENSE/README. Invoked via tsup's
 * onSuccess hook.
 *
 * Runtime dep versions are pinned from pnpm-lock.yaml (lockedVersion) so the
 * published artifact locks to exactly what we build and test against. The
 * published `dependencies` come from `runtime-externals.json` — the SAME single
 * source tsup uses for its `external` list. They are deliberately NOT in this
 * package's package.json `dependencies`: declaring the fastify family there
 * makes pnpm materialise a second physical fastify copy in the workspace
 * (peer-differentiation), which breaks @owl/daemon's tsc build. Since the list
 * holds only external runtime deps (workspace packages are bundled), no
 * workspace or private package can leak into the published manifest.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, '..');
const repoRoot = join(serverDir, '..', '..');
const distDir = join(serverDir, 'dist');

const workspacePkg = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'));
const runtimeExternals = JSON.parse(
  readFileSync(join(serverDir, 'runtime-externals.json'), 'utf8'),
);

/**
 * Pin to the EXACT version currently installed in the workspace — that's what we
 * bundled and tested against. In this hoisted node_modules there is one resolved
 * copy per package, so `node_modules/<name>/package.json` is authoritative (more
 * robust than regex-parsing the v9 lockfile, which quotes scoped names and can
 * list multiple versions of the same package).
 */
function resolvedVersion(name) {
  const pkgPath = join(repoRoot, 'node_modules', name, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(`[gen-manifest] runtime external ${name} is not installed`);
  }
  return JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

const runtimeDeps = {};
for (const name of runtimeExternals) {
  runtimeDeps[name] = resolvedVersion(name);
}

const publishable = {
  name: '@orpheus-aviary/owl-server',
  version: workspacePkg.version,
  type: 'module',
  description: 'Owl cloud server — Fastify daemon + embedded web bundle, same-origin',
  bin: { 'owl-server': 'index.js' },
  files: [
    'index.js',
    'index.js.map',
    'web',
    'migrations',
    'owl_config.toml.sample',
    'README.md',
    'LICENSE',
  ],
  engines: { node: '>=22.0.0' },
  dependencies: runtimeDeps,
  repository: { type: 'git', url: 'https://github.com/orpheus-aviary/owl' },
  license: 'MIT',
};

if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

// Fail closed on a split bundle. `files` above ships exactly `index.js`, so any
// extra emitted .js (tsup code-splits on a dynamic `import()`) would be left
// behind by `npm publish` and the server would die on first use — with a
// module-not-found for a hashed filename that exists locally, which is about
// the worst debugging experience we could hand an operator. Caught for real
// once: a lazy `import('../cloud-login.js')` added two chunks.
const strayJs = readdirSync(distDir).filter((f) => f.endsWith('.js') && f !== 'index.js');
if (strayJs.length > 0) {
  console.error(
    [
      `[gen-manifest] tsup emitted ${strayJs.length} extra JS file(s): ${strayJs.join(', ')}`,
      'The published package ships only index.js, so these would be missing at runtime.',
      'Cause is almost always a dynamic import() in the bundled graph — make it static,',
      'or add the chunks to `files` AND verify a clean `npm pack` install.',
    ].join('\n'),
  );
  process.exit(1);
}

writeFileSync(join(distDir, 'package.json'), `${JSON.stringify(publishable, null, 2)}\n`);

// Embed the built web bundle (apps/web/dist → dist/web). Fail closed if it's
// missing — a stale/absent web build would otherwise ship a broken package.
const webSrc = join(repoRoot, 'apps/web/dist');
if (!existsSync(join(webSrc, 'index.html'))) {
  console.error(
    [
      `[gen-manifest] apps/web/dist/index.html not found (${webSrc}).`,
      'Build the web bundle first: pnpm --filter @owl/web build (or `just build-server`).',
    ].join('\n'),
  );
  process.exit(1);
}
cpSync(webSrc, join(distDir, 'web'), { recursive: true });

// Copy core migrations next to the bundle. The bundled core resolves them via
// import.meta.url, which is the bundle location (dist/index.js) → dist/migrations.
const migrationsSrc = join(repoRoot, 'packages/core/src/db/migrations');
const migrationsDest = join(distDir, 'migrations');
mkdirSync(migrationsDest, { recursive: true });
for (const entry of readdirSync(migrationsSrc).filter((f) => /^\d{4}_.+\.sql$/.test(f))) {
  copyFileSync(join(migrationsSrc, entry), join(migrationsDest, entry));
}

// Ship the sample config (referenced by resolveServerConfig's fail-closed error).
copyFileSync(join(serverDir, 'owl_config.toml.sample'), join(distDir, 'owl_config.toml.sample'));

// LICENSE + README (best-effort).
const licenseSrc = join(repoRoot, 'LICENSE');
if (existsSync(licenseSrc)) copyFileSync(licenseSrc, join(distDir, 'LICENSE'));
const readmeSrc = join(serverDir, 'README.md');
if (existsSync(readmeSrc)) copyFileSync(readmeSrc, join(distDir, 'README.md'));

console.log('[gen-manifest] wrote dist/package.json + embedded web/migrations/sample');
