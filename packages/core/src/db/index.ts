import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  IncompatibleDbError,
  LATEST_KNOWN_VERSION,
  MigrationRequiredError,
  applyForwardMigrations,
  applyInitialSchema,
  isSchemaEmpty,
} from './migrate.js';
import * as schema from './schema.js';

export type OwlDatabase = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseOptions {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Enable WAL mode (default: true) */
  wal?: boolean;
  /** Enable foreign keys (default: true) */
  foreignKeys?: boolean;
}

/**
 * Open an owl database, dispatching on PRAGMA user_version:
 *
 *   v > LATEST_KNOWN_VERSION                  -> IncompatibleDbError (refuse)
 *   v == 0 && schema empty (brand new file)   -> apply 0001_initial.sql
 *   v == 0 && schema non-empty (pre-v0.3 db)  -> MigrationRequiredError
 *   0 < v < LATEST                            -> apply forward migrations
 *   v == LATEST                               -> open as-is
 *
 * Order matters: the v>LATEST check must come before v==0 handling, or a
 * future database at user_version=2 would be misread as "brand new" when it
 * isn't.
 */
export function createDatabase(options: DatabaseOptions): {
  db: OwlDatabase;
  sqlite: BetterSqlite3.Database;
} {
  const { dbPath, wal = true, foreignKeys = true } = options;

  const sqlite = new BetterSqlite3(dbPath);

  // Any failure past the open — refused version, a mid-migration throw from
  // applyInitialSchema / applyForwardMigrations — must close the handle, or
  // a caller that retries (e.g. profile switch's PREPARE) leaks an open fd /
  // a WAL lock on the file. P5-d Phase 14 (P3).
  try {
    if (wal) {
      sqlite.pragma('journal_mode = WAL');
    }
    if (foreignKeys) {
      sqlite.pragma('foreign_keys = ON');
    }
    sqlite.pragma('busy_timeout = 5000');

    const v = sqlite.pragma('user_version', { simple: true }) as number;

    if (v > LATEST_KNOWN_VERSION) {
      throw new IncompatibleDbError(dbPath, v);
    }

    if (v === 0) {
      if (isSchemaEmpty(sqlite)) {
        applyInitialSchema(sqlite);
      } else {
        throw new MigrationRequiredError(dbPath);
      }
    } else if (v < LATEST_KNOWN_VERSION) {
      applyForwardMigrations(sqlite, v, LATEST_KNOWN_VERSION);
    }
    // else v === LATEST_KNOWN_VERSION: open as-is

    return { db: drizzle(sqlite, { schema }), sqlite };
  } catch (err) {
    sqlite.close();
    throw err;
  }
}

export { schema };
export { updateFtsTagsText } from './fts.js';
