#!/usr/bin/env node
// Generate the PWA install icons for the web app from the owl logo, using macOS
// `sips`. Products are committed to git under `apps/web/public/` and served
// same-origin by the daemon (see web-host CSP `img-src` / `manifest-src`).
//
// ⚠️ RUN MANUALLY ON macOS ONLY — this is NOT wired into `build-server` /
// `electron-vite build` / CI: `sips` is macOS-only and the outputs are
// checked in, so the bundle never depends on regenerating them. Re-run only
// when the source logo changes:
//
//     node scripts/build-pwa-icons.mjs
//
// Maskable icon: Android/Chrome crop maskable icons to a safe zone (~80% of the
// canvas). We shrink the logo to 80% and pad it out to the full size on the app
// background so the crop never clips the owl.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(repoRoot, 'packages/gui/resources/owl-logo-original.png');
const OUT_DIR = join(repoRoot, 'apps/web/public');
const ICONS_DIR = join(OUT_DIR, 'icons');

// App background (near-black; matches the always-dark web shell). Used as the
// maskable pad colour and the manifest background_color.
const BG_HEX = '0a0a0a';

function sips(args) {
  execFileSync('sips', args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

/** Square resize of the source logo to `size` → `out`. */
function resizeTo(size, out) {
  sips(['-z', String(size), String(size), SOURCE, '--out', out]);
}

/** Maskable: logo at ~80% centred on a `size` background square. */
function maskableTo(size, out) {
  const inner = Math.round(size * 0.8);
  resizeTo(inner, out); // shrink first
  sips(['-p', String(size), String(size), '--padColor', BG_HEX, out, '--out', out]); // pad to full
}

function main() {
  mkdirSync(ICONS_DIR, { recursive: true });
  resizeTo(192, join(ICONS_DIR, 'icon-192.png'));
  resizeTo(512, join(ICONS_DIR, 'icon-512.png'));
  maskableTo(512, join(ICONS_DIR, 'icon-512-maskable.png'));
  resizeTo(180, join(OUT_DIR, 'apple-touch-icon.png'));
  console.log('PWA icons written to apps/web/public/{icons,apple-touch-icon.png}');
}

main();
