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

/** Owl database file path (legacy global db; per-profile path resolution is
 * P5-d Phase 12's `resolveActiveProfileDbPath` — this stays as the
 * pre-migration / escape-hatch fallback). */
export function dbPath(): string {
  return join(owlDir(), 'owl.db');
}

/** Per-profile data root: ~/orpheus-aviary-nest/owl/profiles/ (P5-d Phase 12) */
export function profilesDir(): string {
  return join(owlDir(), 'profiles');
}

/** Per-profile database file: profiles/<profileId>/owl.db (P5-d Phase 12) */
export function profileDbPath(profileId: string): string {
  return join(profilesDir(), profileId, 'owl.db');
}

/**
 * Local profile database = `owl/owl.db` in place (P5-d Phase 13, D10a).
 *
 * The never-logged-in / offline workspace. Phase 12 provisionally pointed
 * this at `profiles/local/owl.db`; Phase 13 remaps it onto the legacy db so
 * pure-local users need zero migration. Account sync never writes here.
 */
export function localProfileDbPath(): string {
  return dbPath();
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

/** Skybridge directory: ~/orpheus-aviary-nest/skybridge/ */
export function skybridgeDir(): string {
  return join(nestDir(), 'skybridge');
}

/** Skybridge client config (owl-side connection state, not server.toml) */
export function skybridgeConfigPath(): string {
  return join(skybridgeDir(), 'skybridge_config.toml');
}
