// Startup state probe used by GUI main-process precheck.
//
// Opens the db read-only (fileMustExist + readonly), peeks user_version and
// schema emptiness, closes cleanly. Never writes, never stamps user_version,
// never creates -wal / -shm side files — so the subsequent migrateLegacyDb
// call can freely acquire the Layer 3 `locking_mode=EXCLUSIVE` lock.
//
// This lives in @owl/core (not @owl/gui) so that @owl/gui doesn't have to
// import better-sqlite3 directly. @owl/gui depends on @owl/core, @owl/core
// already ships better-sqlite3 for createDatabase / migrateLegacyDb.

import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { isSchemaEmpty } from './migrate.js';

export type StartupProbeResult =
  | { kind: 'not-found' }
  | { kind: 'version'; version: number; schemaEmpty: boolean };

export function probeStartupState(dbPath: string): StartupProbeResult {
  if (!existsSync(dbPath)) return { kind: 'not-found' };

  const sqlite = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  try {
    const version = sqlite.pragma('user_version', { simple: true }) as number;
    const schemaEmpty = isSchemaEmpty(sqlite);
    return { kind: 'version', version, schemaEmpty };
  } finally {
    sqlite.close();
  }
}
