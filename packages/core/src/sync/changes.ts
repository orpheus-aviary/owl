import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * P4 Phase 2 — local change-log emission.
 *
 * Every business-table mutation in @owl/core appends one (or more) rows to
 * `sync_changes` inside the same sqlite transaction. Phase 3 sync engine
 * consumes this stream to push to skybridge server.
 *
 * Payload shapes are documented in
 * `docs/plans/2026-05-08-p4-phase2-change-log-design.md`.
 */

export type SyncEntityType = 'note' | 'folder' | 'conversation';

export type SyncOp = 'create' | 'update' | 'trash' | 'restore' | 'delete' | 'pin' | 'append';

export interface EmitSyncChangeArgs {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncOp;
  /** Plain JS object; serialised to JSON. Shape depends on (entityType, op). */
  payload: Record<string, unknown>;
  /**
   * Override the row's `created_at` (Unix ms). Default `Date.now()`.
   * Tests pass a fixed value for deterministic ordering assertions.
   */
  nowMs?: number;
}

/**
 * Append a sync_changes row.
 *
 * Caller responsibility: invoke inside an outer `sqlite.transaction(...)`
 * scope so the row rolls back together with the business-table mutation.
 *
 * Reads `device_id` from `local_metadata.device_uuid`. If absent (e.g.
 * core unit tests that just opened :memory: without calling
 * `ensureDeviceId`), inserts a fresh UUID as a safety net so the
 * `sync_changes.device_id NOT NULL` constraint never fires unexpectedly.
 * Production daemon always calls `ensureDeviceId` at boot — the fallback
 * exists only to keep core mutation tests self-contained.
 */
/**
 * Appends one row to sync_changes and returns the generated `client_change_id`.
 *
 * P5-a Step 4a: cid is required by skybridge push semantics — server uses it
 * to dedupe (accepted vs duplicates), and crash + replay must produce the
 * same cid for the same row. Generated per-row with `randomUUID()`. Returned
 * for tests/correlation; existing call sites don't need to capture it.
 *
 * No payload validation runs at emit. Validation is apply-side only
 * (`parseNotePayload`) — design doc §3.3 / §6.3 explain why:
 *  - pin / reorder emits omit `updated_at_ms` by design, would false-positive
 *  - emit is internal trusted code; apply is the external-data boundary
 */
export function emitSyncChange(sqlite: Database.Database, args: EmitSyncChangeArgs): string {
  const deviceId = readOrInitDeviceId(sqlite);
  const clientChangeId = randomUUID();
  const createdAt = args.nowMs ?? Date.now();
  sqlite
    .prepare(
      `INSERT INTO sync_changes
         (device_id, entity_type, entity_id, op, payload, created_at, client_change_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      deviceId,
      args.entityType,
      args.entityId,
      args.op,
      JSON.stringify(args.payload),
      createdAt,
      clientChangeId,
    );
  return clientChangeId;
}

function readOrInitDeviceId(sqlite: Database.Database): string {
  const row = sqlite.prepare("SELECT value FROM local_metadata WHERE key = 'device_uuid'").get() as
    | { value: string | null }
    | undefined;
  if (row?.value) return row.value;

  const fresh = randomUUID();
  sqlite
    .prepare(
      "INSERT INTO local_metadata (key, value) VALUES ('device_uuid', ?) ON CONFLICT(key) DO NOTHING",
    )
    .run(fresh);
  // Re-read in case a parallel caller inserted concurrently.
  const final = sqlite
    .prepare("SELECT value FROM local_metadata WHERE key = 'device_uuid'")
    .get() as { value: string };
  return final.value;
}
