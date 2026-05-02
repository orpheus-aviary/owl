import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  bundle: true,
  noExternal: ['@owl/core'],
  external: [
    'better-sqlite3',
    'drizzle-orm',
    'commander',
    'pino',
    'pino-roll',
    'smol-toml',
    'uuid',
  ],
  sourcemap: true,
  clean: true,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
  outDir: 'dist',
  onSuccess: 'node scripts/gen-publishable-manifest.mjs',
});
