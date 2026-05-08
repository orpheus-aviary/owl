#!/usr/bin/env node
/**
 * Generate dist/package.json and copy README / LICENSE / migrations
 * SQL after tsup build. Invoked via tsup's onSuccess hook.
 *
 * Version numbers for runtime deps are pulled from the workspace's
 * pnpm-lock.yaml so the published artifact locks to exactly what we
 * build and test against.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = join(here, '..');
const repoRoot = join(cliDir, '..', '..');

const workspacePkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
const lockfile = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8');

/** Parse a dependency version out of pnpm-lock.yaml's top-level deps map. */
function lockedVersion(name) {
  // Matches `  better-sqlite3: <version>` or `  better-sqlite3(node):` patterns
  const escaped = name.replace(/[/.\-]/g, (c) => `\\${c}`);
  const match = lockfile.match(new RegExp(`\\n${escaped}@([^:\\n]+):`, 'm'));
  if (!match) {
    // Fallback: use the range in the workspace manifest verbatim
    return workspacePkg.dependencies[name];
  }
  return match[1].trim();
}

const runtimeDeps = {};
for (const [name, range] of Object.entries(workspacePkg.dependencies)) {
  if (name === '@owl/core') continue; // bundled via noExternal
  runtimeDeps[name] = range;
}

const publishable = {
  name: '@orpheus-aviary/owl-cli',
  version: workspacePkg.version,
  type: 'module',
  description: 'Owl notes CLI — agent-first interface to the owl note database',
  bin: {
    owl: 'index.js',
    'owl-cli': 'index.js',
  },
  files: ['index.js', 'index.js.map', 'README.md', 'LICENSE', 'migrations/*.sql'],
  engines: { node: '>=22.0.0' },
  dependencies: runtimeDeps,
  repository: {
    type: 'git',
    url: 'https://github.com/orpheus-aviary/owl',
  },
  license: 'MIT',
};

const distDir = join(cliDir, 'dist');
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, 'package.json'), `${JSON.stringify(publishable, null, 2)}\n`);

// Copy LICENSE from repo root
const licenseSrc = join(repoRoot, 'LICENSE');
if (existsSync(licenseSrc)) copyFileSync(licenseSrc, join(distDir, 'LICENSE'));

// Copy README if present
const readmeSrc = join(cliDir, 'README.md');
if (existsSync(readmeSrc)) copyFileSync(readmeSrc, join(distDir, 'README.md'));

// Copy migrations SQL (needed by @owl/core's migration runner at runtime).
// Copy ALL NNNN_*.sql so applyForwardMigrations can walk past the initial
// schema; previously this hard-coded only 0001 which broke fresh `--direct`
// installs once LATEST_KNOWN_VERSION moved past 1.
const migrationsSrc = join(repoRoot, 'packages/core/src/db/migrations');
if (existsSync(migrationsSrc)) {
  const dest = join(distDir, 'migrations');
  mkdirSync(dest, { recursive: true });
  const sqlFiles = readdirSync(migrationsSrc).filter((f) => /^\d{4}_.+\.sql$/.test(f));
  for (const entry of sqlFiles) {
    copyFileSync(join(migrationsSrc, entry), join(dest, entry));
  }
}

console.log('[gen-publishable-manifest] wrote dist/package.json, LICENSE, migrations');
