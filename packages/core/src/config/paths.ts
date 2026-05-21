import { homedir } from 'node:os';
import { join } from 'node:path';

const NEST_DIR = 'orpheus-aviary-nest';
const OWL_DIR = 'owl';

/**
 * Root data directory.
 *
 * Honors `OWL_NEST_DIR` env override so multiple owl profiles can coexist on
 * the same machine (e.g. P5-a manual sync acceptance, where profile A uses
 * the default nest and profile B uses `OWL_NEST_DIR=$HOME/...-profileB`).
 *
 * Re-evaluated on every call — tests can flip the env between assertions
 * without module-state reset gymnastics.
 *
 * Fallback: `~/orpheus-aviary-nest/`.
 */
export function nestDir(): string {
  const override = process.env.OWL_NEST_DIR;
  if (override && override.length > 0) return override;
  return join(homedir(), NEST_DIR);
}

/** Owl data directory: ~/orpheus-aviary-nest/owl/ */
export function owlDir(): string {
  return join(nestDir(), OWL_DIR);
}

/** Owl config file path */
export function configPath(): string {
  return join(owlDir(), 'owl_config.toml');
}

/** Owl database file path */
export function dbPath(): string {
  return join(owlDir(), 'owl.db');
}

/** Owl sync database file path (for migration) */
export function syncDbPath(): string {
  return join(owlDir(), 'owl.sync.db');
}

/** Owl log directory */
export function logDir(): string {
  return join(owlDir(), 'logs');
}

/** Owl GUI log file path */
export function owlLogPath(): string {
  return join(logDir(), 'owl.log');
}

/** Owl daemon log file path */
export function daemonLogPath(): string {
  return join(logDir(), 'daemon.log');
}

/** Daemon PID file path */
export function pidPath(): string {
  return join(owlDir(), 'daemon.pid');
}

/** Aviary shared config (LLM fallback) */
export function aviaryConfigPath(): string {
  return join(nestDir(), 'aviary', 'aviary_config.toml');
}

/** Migration config path */
export function migrationConfigPath(): string {
  return join(nestDir(), 'migration', 'config.toml');
}
