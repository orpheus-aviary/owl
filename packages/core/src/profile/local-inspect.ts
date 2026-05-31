/**
 * P5-d Phase 16 (D10b / B2 / B8) — local profile inspection + whole-db claim.
 *
 * On a first login to an *empty* account, the user may "claim" their local
 * workspace into it: copy `owl/owl.db` → `profiles/<id>/owl.db` (a whole-db
 * claim, never a move — account sync must never write the local db).
 *
 * These two helpers are the local-side primitives the GUI main login flow
 * calls *before* switching the daemon onto the target profile (blocker B9):
 *   - `inspectLocalProfile()` — how many notes does local hold, and does it
 *     carry stale sync traces (B8 legacy-orphan warning)?
 *   - `copyLocalProfileDbInto(target)` — the whole-db copy.
 *
 * Both open the local db read-only via a raw better-sqlite3 connection (no
 * migration side effects, WAL-concurrent with the running daemon).
 */

import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { localProfileDbPath } from '../config/paths.js';
import { backupDatabase } from '../db/backup.js';

export interface LocalProfileInspection {
  /** Notes not in permanent trash (`trash_level < 2`); 0 if the db/table is absent. */
  noteCount: number;
  /**
   * True if the local db carries leftover sync state from a prior account — a
   * `sync_cursor` row, a pushed (`synced_at NOT NULL`) change, or a stored
   * skybridge device/workspace id. Only happens on a legacy-migrated db (a
   * pre-0.5.0 account db kept in place as local). Drives the B8 warning:
   * claiming it into a new account would re-upload those traces.
   */
  hasSyncTraces: boolean;
}

/** A row exists for `sql`, treating a missing table (older schema) as "no". */
function hasRow(sqlite: BetterSqlite3.Database, sql: string): boolean {
  try {
    return sqlite.prepare(sql).get() !== undefined;
  } catch {
    return false;
  }
}

/**
 * Inspect the local profile db (`owl/owl.db`) read-only. Independent of which
 * profile the daemon is currently on — the claim source is always local
 * (D10b). Returns zeros for a never-created local db.
 */
export function inspectLocalProfile(): LocalProfileInspection {
  const path = localProfileDbPath();
  if (!existsSync(path)) return { noteCount: 0, hasSyncTraces: false };

  const sqlite = new BetterSqlite3(path, { readonly: true });
  try {
    let noteCount = 0;
    try {
      const row = sqlite.prepare('SELECT count(*) AS n FROM notes WHERE trash_level < 2').get() as
        | { n: number }
        | undefined;
      noteCount = row?.n ?? 0;
    } catch {
      noteCount = 0; // notes table absent on a very old schema
    }
    const hasSyncTraces =
      hasRow(sqlite, 'SELECT 1 FROM sync_cursor LIMIT 1') ||
      hasRow(sqlite, 'SELECT 1 FROM sync_changes WHERE synced_at IS NOT NULL LIMIT 1') ||
      hasRow(
        sqlite,
        "SELECT 1 FROM local_metadata WHERE key IN ('skybridge_device_id','skybridge_workspace_id') LIMIT 1",
      );
    return { noteCount, hasSyncTraces };
  } finally {
    sqlite.close();
  }
}

/**
 * Whole-db claim: copy the local profile db into `targetPath` (the target
 * profile's `owl.db`). The caller ensures the parent dir exists and that this
 * runs *before* the daemon switches onto the target. The local db is read
 * only and left untouched (account sync never writes local, D10b).
 */
export async function copyLocalProfileDbInto(targetPath: string): Promise<void> {
  const sqlite = new BetterSqlite3(localProfileDbPath(), { readonly: true });
  try {
    await backupDatabase(sqlite, targetPath);
  } finally {
    sqlite.close();
  }
}
