import { existsSync, readFileSync } from 'node:fs';
import { type OwlConfig, loadConfig, paths } from '@owl/core';
import { parse } from 'smol-toml';
import { sampleConfigPath } from './embedded.js';

/** ⭐7 — owl-server default port (core/desktop keeps 47010). */
const DEFAULT_SERVER_PORT = 47020;

/**
 * Resolve the config for the packaged owl-server. Deliberately fail-closed and
 * distinct from `loadConfig()`:
 *   - the config file MUST already exist (owl-server never auto-writes a local
 *     default — `loadConfig` on a missing file would silently produce an
 *     unauthenticated `mode:'local'` daemon);
 *   - `[daemon].mode` MUST be `'cloud'`;
 *   - `[daemon].port` defaults to 47020 only when the operator omitted it.
 *
 * This runs BEFORE the daemon logger exists, so fatal misconfig prints a
 * friendly message and `process.exit(1)`s rather than throwing a raw stack.
 */
export function resolveServerConfig(): OwlConfig {
  const configPath = paths.configPath();
  if (!existsSync(configPath)) {
    fatal(
      [
        `No config found at ${configPath}`,
        'owl-server needs a cloud [daemon] config. Copy the sample and fill it in:',
        `  cp ${sampleConfigPath()} ${configPath}`,
        'then set [daemon].server_url / account_lock / public_url.',
      ].join('\n'),
    );
  }

  const config = loadConfig();

  if (config.daemon.mode !== 'cloud') {
    fatal(
      `owl-server requires [daemon].mode = 'cloud' (got ${JSON.stringify(
        config.daemon.mode,
      )}). See the sample at ${sampleConfigPath()}.`,
    );
  }

  // ⭐7 — default port 47020 when the operator did NOT set [daemon].port. Re-read
  // the raw toml to distinguish "unset" from an explicit 47010, since loadConfig
  // has already merged the core default (47010) in.
  const raw = parse(readFileSync(configPath, 'utf-8')) as { daemon?: { port?: unknown } };
  if (raw.daemon?.port === undefined) {
    config.daemon.port = DEFAULT_SERVER_PORT;
  }

  return config;
}

function fatal(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}
