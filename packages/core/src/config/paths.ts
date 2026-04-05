import { homedir } from 'node:os';
import { join } from 'node:path';

const NEST_DIR = 'orpheus-aviary-nest';
const OWL_DIR = 'owl';

/** Root data directory: ~/orpheus-aviary-nest/ */
export function nestDir(): string {
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
