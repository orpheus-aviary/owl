#!/usr/bin/env node
/**
 * P5-a Step 9 — skybridge tarball install/uninstall.
 *
 *   node scripts/skybridge-overrides.mjs install <dist-pack-dir>
 *   node scripts/skybridge-overrides.mjs uninstall
 *
 * `install` scans <dist-pack-dir>/ for the three skybridge tarballs
 * (proto / client / server), writes absolute `file:` overrides into
 * root `package.json` `pnpm.overrides`, and adds
 *   - @skybridge/client → packages/daemon dependencies
 *   - @skybridge/server → packages/daemon devDependencies
 *
 * `uninstall` reverses both patches — leaves the manifests exactly as
 * the guard at `scripts/check-skybridge-not-committed.sh` expects.
 *
 * The whole patch is atomic: a snapshot of every file we touch is held
 * in memory; on any error we restore originals before rethrowing, so
 * neither half-patched manifests nor a broken lockfile are left behind.
 *
 * `pnpm install` is the caller's responsibility (justfile does it). The
 * script intentionally does no shelling out — keeps this file pure JS,
 * deterministic, and easy to test by hand.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTO = '@skybridge/proto';
const CLIENT = '@skybridge/client';
const SERVER = '@skybridge/server';
const SKYBRIDGE_NAMES = [PROTO, CLIENT, SERVER];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const rootPkgPath = join(repoRoot, 'package.json');
const daemonPkgPath = join(repoRoot, 'packages', 'daemon', 'package.json');

// ─── tarball discovery ──────────────────────────────────────────────

/**
 * Map each skybridge package name to its absolute tarball path under
 * `<distPackDir>/`. Tarballs come out of `npm pack` named
 * `skybridge-<short>-<version>.tgz`, where <short> drops the @scope/.
 */
function findTarballs(distPackDir) {
  if (!existsSync(distPackDir)) {
    throw new Error(
      `dist-pack directory not found: ${distPackDir} — run 'just pack-all' in the skybridge repo first`,
    );
  }
  const entries = readdirSync(distPackDir).filter((f) => f.endsWith('.tgz'));
  const out = {};
  const expectedPrefixes = {
    [PROTO]: 'skybridge-proto-',
    [CLIENT]: 'skybridge-client-',
    [SERVER]: 'skybridge-server-',
  };
  for (const name of SKYBRIDGE_NAMES) {
    const prefix = expectedPrefixes[name];
    const matches = entries.filter((f) => f.startsWith(prefix));
    if (matches.length === 0) {
      throw new Error(
        `no tarball matching ${prefix}*.tgz in ${distPackDir} — re-run 'just pack-${name.split('/')[1]}'`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `multiple ${prefix}*.tgz in ${distPackDir} (${matches.join(', ')}) — clean dist-pack/ first`,
      );
    }
    out[name] = resolve(distPackDir, matches[0]);
  }
  return out;
}

// ─── manifest read/write with formatting preservation ───────────────

function readJsonText(path) {
  return readFileSync(path, 'utf8');
}

function detectIndent(text) {
  // Trim BOM if present, then look at the first indented line.
  const stripped = text.replace(/^﻿/, '');
  const m = stripped.match(/\n(\s+)\S/);
  if (!m) return '  ';
  // Common cases: spaces, tabs.
  return m[1];
}

function writeManifest(path, obj, originalText) {
  const indent = detectIndent(originalText);
  const trailingNewline = originalText.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${JSON.stringify(obj, null, indent)}${trailingNewline}`, 'utf8');
}

// ─── patch logic ─────────────────────────────────────────────────────

function patchRootPnpmOverrides(rootPkg, tarballs) {
  rootPkg.pnpm = rootPkg.pnpm ?? {};
  rootPkg.pnpm.overrides = rootPkg.pnpm.overrides ?? {};
  for (const name of SKYBRIDGE_NAMES) {
    // file: URIs in pnpm overrides accept absolute paths directly
    rootPkg.pnpm.overrides[name] = `file:${tarballs[name]}`;
  }
  return rootPkg;
}

function unpatchRootPnpmOverrides(rootPkg) {
  if (!rootPkg.pnpm?.overrides) return rootPkg;
  for (const name of SKYBRIDGE_NAMES) {
    delete rootPkg.pnpm.overrides[name];
  }
  // Tidy up empty containers so the diff is minimal. We use `delete` so
  // the keys don't appear in the JSON output at all — assigning undefined
  // would leave `"overrides": null` instead, defeating the purpose.
  if (Object.keys(rootPkg.pnpm.overrides).length === 0) {
    // biome-ignore lint/performance/noDelete: JSON.stringify keeps `undefined`-valued keys as nothing, but writeManifest preserves shape; delete is the unambiguous remove
    delete rootPkg.pnpm.overrides;
  }
  if (rootPkg.pnpm && Object.keys(rootPkg.pnpm).length === 0) {
    // biome-ignore lint/performance/noDelete: same as above
    delete rootPkg.pnpm;
  }
  return rootPkg;
}

function patchDaemonManifest(daemonPkg) {
  // Tarballs themselves carry exact versions via overrides; we list the
  // semver range that matches what skybridge actually publishes at 0.1.0.
  daemonPkg.dependencies = { ...(daemonPkg.dependencies ?? {}), [CLIENT]: '^0.1.0' };
  daemonPkg.devDependencies = {
    ...(daemonPkg.devDependencies ?? {}),
    [SERVER]: '^0.1.0',
  };
  return daemonPkg;
}

function unpatchDaemonManifest(daemonPkg) {
  if (daemonPkg.dependencies) delete daemonPkg.dependencies[CLIENT];
  if (daemonPkg.devDependencies) delete daemonPkg.devDependencies[SERVER];
  return daemonPkg;
}

// ─── atomic apply (snapshot + restore on error) ──────────────────────

/**
 * Run a list of write operations against on-disk manifests. If any step
 * throws, restore every file we already touched from the pre-op snapshot
 * before rethrowing. Lockfile / `pnpm install` is the caller's problem;
 * the snapshot covers only the JSON manifests we patch.
 */
function atomic(operations) {
  const snapshots = [];
  for (const op of operations) {
    snapshots.push({ path: op.path, originalText: op.originalText });
  }
  try {
    for (const op of operations) {
      writeManifest(op.path, op.next, op.originalText);
    }
  } catch (err) {
    for (const snap of snapshots) {
      try {
        writeFileSync(snap.path, snap.originalText, 'utf8');
      } catch (restoreErr) {
        console.error(`[skybridge-overrides] failed to restore ${snap.path}:`, restoreErr);
      }
    }
    throw err;
  }
}

// ─── public commands ─────────────────────────────────────────────────

function cmdInstall(distPackDirArg) {
  if (!distPackDirArg) {
    throw new Error('usage: skybridge-overrides install <dist-pack-dir>');
  }
  const distPackDir = isAbsolute(distPackDirArg)
    ? distPackDirArg
    : resolve(process.cwd(), distPackDirArg);

  const tarballs = findTarballs(distPackDir);

  const rootText = readJsonText(rootPkgPath);
  const rootNext = patchRootPnpmOverrides(JSON.parse(rootText), tarballs);

  const daemonText = readJsonText(daemonPkgPath);
  const daemonNext = patchDaemonManifest(JSON.parse(daemonText));

  atomic([
    { path: rootPkgPath, originalText: rootText, next: rootNext },
    { path: daemonPkgPath, originalText: daemonText, next: daemonNext },
  ]);

  console.log('[skybridge-overrides] install — patched manifests:');
  for (const name of SKYBRIDGE_NAMES) {
    console.log(`  ${name} -> file:${tarballs[name]}`);
  }
  console.log('[skybridge-overrides] run `pnpm install` to apply the lockfile change');
}

function cmdUninstall() {
  const rootText = readJsonText(rootPkgPath);
  const rootNext = unpatchRootPnpmOverrides(JSON.parse(rootText));

  const daemonText = readJsonText(daemonPkgPath);
  const daemonNext = unpatchDaemonManifest(JSON.parse(daemonText));

  atomic([
    { path: rootPkgPath, originalText: rootText, next: rootNext },
    { path: daemonPkgPath, originalText: daemonText, next: daemonNext },
  ]);

  console.log('[skybridge-overrides] uninstall — manifests restored');
  console.log('[skybridge-overrides] run `pnpm install` to apply the lockfile change');
}

// ─── entry ───────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'install') {
    cmdInstall(rest[0]);
  } else if (cmd === 'uninstall') {
    cmdUninstall();
  } else {
    console.error('usage: skybridge-overrides <install <dist-pack-dir> | uninstall>');
    process.exit(2);
  }
} catch (err) {
  console.error(`[skybridge-overrides] ${err.message}`);
  process.exit(1);
}
