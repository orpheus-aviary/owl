import { existsSync } from 'node:fs';
import { type OwlConfig, loadConfig, paths, resolveActiveProfileDbPath } from '@owl/core';
import { CliError } from './errors.js';

export interface ResolvedConfig {
  config: OwlConfig;
  configPath: string;
  dbPath: string;
  pidPath: string;
  daemonPort: number;
  dataDir: string;
}

export interface ConfigOverrides {
  /** `--config <path>` — overrides owl_config.toml location. */
  configPath?: string;
  /** `--db <path>` — overrides `[data].db_path`. Triggers direct mode. */
  dbPath?: string;
}

/**
 * Resolve the config + derived paths with CLI flag overrides applied.
 *
 * - `--config <path>` replaces the default `~/orpheus-aviary-nest/owl/owl_config.toml`.
 * - `--db <path>` replaces the db path (even though loadConfig doesn't
 *   model it as configurable — db_path is a CLI-only concept in P3.2-c).
 * - Missing config file → `CONFIG_NOT_FOUND` (CLI can still run without a
 *   nest directory for `doctor --db` workflows, so this is raised only
 *   when a real path miss blocks progress).
 */
export function resolveConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const cfgPath = overrides.configPath ?? paths.configPath();
  if (overrides.configPath && !existsSync(overrides.configPath)) {
    throw new CliError('CONFIG_NOT_FOUND', `config file not found: ${overrides.configPath}`, {
      path: overrides.configPath,
    });
  }
  // loadConfig() tolerates a missing default-path file by returning defaults,
  // which matches our "read command always allowed" stance. If the user
  // explicitly passed --config we want the hard error above.
  const config = loadConfig(cfgPath);
  const daemonPort = config.daemon?.port ?? 47010;
  // P5-d Phase 12 (B6): `--db` stays an explicit escape hatch; otherwise the
  // direct-mode default resolves to the active profile's db (legacy fallback
  // pre-migration, so behavior is unchanged today).
  const dbPath = overrides.dbPath ?? resolveActiveProfileDbPath();
  return {
    config,
    configPath: cfgPath,
    dbPath,
    pidPath: paths.pidPath(),
    daemonPort,
    dataDir: paths.owlDir(),
  };
}
