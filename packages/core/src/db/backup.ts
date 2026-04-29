// Online backup of a live SQLite database to a separate file.
//
// Wraps better-sqlite3's Database.backup() which takes a consistent snapshot
// while the source remains open (WAL-aware, no lock required on the caller
// side). Kept as a standalone utility because the backup pattern is reusable
// outside the one-shot legacy migration: future `owl export`, `owl doctor
// --backup`, or scheduled backups can all call this without pulling in
// migrate.ts.

import type BetterSqlite3 from 'better-sqlite3';

/**
 * Copy the contents of `sqlite` into a new database file at `targetPath`.
 *
 * - `sqlite` must be an open connection. Its own file and the target file
 *   must be distinct paths.
 * - `targetPath` is overwritten if it exists.
 * - The source database remains usable (read and write) after this resolves.
 * - `targetPath` is a self-contained database with no WAL sidecar.
 */
export async function backupDatabase(
  sqlite: BetterSqlite3.Database,
  targetPath: string,
): Promise<void> {
  await sqlite.backup(targetPath);
}
