/**
 * P5-b §6.1 — skybridge identity persistence in `local_metadata`.
 *
 * The daemon's `ensureSkybridgeSession` calls this every time it has a
 * confirmed device + workspace id (from toml or fresh `registerDevice` /
 * `ensureWorkspace`). Two side-effects:
 *
 *   1. `local_metadata.skybridge_device_id` / `skybridge_workspace_id`
 *      get INSERT OR REPLACE'd so mutation paths (`createNote`,
 *      `createFolder`, etc.) can read them via raw SQL without coupling
 *      to daemon code.
 *
 *   2. A one-shot non-destructive backfill: P5-a wrote `notes.device_id`
 *      / `folders.device_id` to the local `device_uuid`; P5-b's contract
 *      reserves that column for the *skybridge* source-device id. Sweep
 *      rows whose `device_id` is NULL or matches the local uuid and
 *      stamp them with the real skybridge id. Apply-written rows (real
 *      remote device ids) are intentionally left alone. The sentinel
 *      `skybridge_backfilled='1'` gates repeated calls.
 *
 * Lives in `@owl/core` to satisfy the P4 Phase 1 invariant — daemon
 * never writes business tables directly.
 */

import type Database from 'better-sqlite3';

interface MetadataRow {
  value: string | null;
}

export function persistSkybridgeIds(
  sqlite: Database.Database,
  skybridgeDeviceId: string,
  workspaceId: string,
): void {
  const upsert = sqlite.prepare(
    `INSERT INTO local_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  upsert.run('skybridge_device_id', skybridgeDeviceId);
  upsert.run('skybridge_workspace_id', workspaceId);

  const flag = sqlite
    .prepare("SELECT value FROM local_metadata WHERE key = 'skybridge_backfilled'")
    .get() as MetadataRow | undefined;
  if (flag?.value === '1') return;

  const localUuid = (
    sqlite.prepare("SELECT value FROM local_metadata WHERE key = 'device_uuid'").get() as
      | MetadataRow
      | undefined
  )?.value;

  sqlite
    .prepare('UPDATE notes SET device_id = ? WHERE device_id IS NULL OR device_id = ?')
    .run(skybridgeDeviceId, localUuid ?? '');
  sqlite
    .prepare('UPDATE folders SET device_id = ? WHERE device_id IS NULL OR device_id = ?')
    .run(skybridgeDeviceId, localUuid ?? '');
  upsert.run('skybridge_backfilled', '1');
}
