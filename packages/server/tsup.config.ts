import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Single source of truth for the runtime externals — shared with
// scripts/gen-publishable-manifest.mjs (which turns the SAME list into the
// published `dependencies`). These are intentionally NOT in package.json
// `dependencies`: declaring the fastify family there makes pnpm materialise a
// second physical fastify copy in the workspace (peer-differentiation), which
// breaks @owl/daemon's tsc build. The bundled daemon+core+shared resolve them
// via workspace hoisting at dev time; a clean `npm install` of the published
// tarball provides them for real.
const RUNTIME_EXTERNALS: string[] = JSON.parse(
  readFileSync(new URL('./runtime-externals.json', import.meta.url), 'utf8'),
);

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  bundle: true,
  noExternal: ['@owl/daemon', '@owl/core', '@orpheus-aviary/owl-shared'],
  external: RUNTIME_EXTERNALS,
  sourcemap: true,
  clean: true,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
  outDir: 'dist',
  onSuccess: 'node scripts/gen-publishable-manifest.mjs',
});
