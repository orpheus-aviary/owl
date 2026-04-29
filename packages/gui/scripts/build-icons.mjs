#!/usr/bin/env node
// Generate resources/icon.icns from resources/owl-logo-original.png
// Uses macOS-bundled `sips` + `iconutil`. No extra deps.
//
// iconset requires specific sizes: 16, 32, 64, 128, 256, 512, 1024
// and the @2x variants for Retina.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resourcesDir = resolve(__dirname, '..', 'resources');
const source = join(resourcesDir, 'owl-logo-original.png');
const iconset = join(resourcesDir, 'icon.iconset');
const output = join(resourcesDir, 'icon.icns');

if (!existsSync(source)) {
  console.error(`Source image not found: ${source}`);
  process.exit(1);
}

if (existsSync(iconset)) rmSync(iconset, { recursive: true });
mkdirSync(iconset, { recursive: true });

// [px, filename]
const sizes = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

for (const [size, name] of sizes) {
  execFileSync('sips', ['-z', String(size), String(size), source, '--out', join(iconset, name)], {
    stdio: 'pipe',
  });
}

execFileSync('iconutil', ['-c', 'icns', iconset, '-o', output], { stdio: 'inherit' });
rmSync(iconset, { recursive: true });

console.log(`Wrote ${output}`);
