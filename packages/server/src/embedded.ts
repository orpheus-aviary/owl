import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * This module is bundled into `dist/index.js`, so `import.meta.url` points at the
 * bundle. The build (`gen-publishable-manifest.mjs`) copies the web bundle to
 * `dist/web/`, the core migrations to `dist/migrations/`, and the sample config
 * to `dist/owl_config.toml.sample` — all resolved relative to HERE at runtime.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the web bundle embedded in the package (`web_root` fallback). */
export function embeddedWebRoot(): string {
  return join(HERE, 'web');
}

/** Absolute path to the shipped sample config (referenced in fail-closed errors). */
export function sampleConfigPath(): string {
  return join(HERE, 'owl_config.toml.sample');
}
