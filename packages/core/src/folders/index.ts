import type Database from 'better-sqlite3';
import { asc, eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { OwlDatabase } from '../db/index.js';
import { folders } from '../db/schema.js';
import { readSkybridgeDeviceId } from '../skybridge/identity.js';
import { emitSyncChange, readLocalDeviceUuid } from '../sync/changes.js';
import { serverNormalizedStamp } from '../sync/hlc.js';

// ─── Types ─────────────────────────────────────────────

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  createdAt: Date;
  updatedAt: Date;
  deviceId: string | null;
}

export interface CreateFolderInput {
  name: string;
  parentId?: string | null;
  position?: number;
  deviceId?: string;
}

export interface UpdateFolderInput {
  name?: string;
  parentId?: string | null;
  position?: number;
  deviceId?: string;
}

export interface ReorderFolderItem {
  id: string;
  parentId: string | null;
  position: number;
}

// ─── CRUD ──────────────────────────────────────────────

export function createFolder(
  db: OwlDatabase,
  sqlite: Database.Database,
  input: CreateFolderInput,
): Folder {
  const id = uuidv4();

  return sqlite
    .transaction(() => {
      // W3: stamp inside the tx so HLC state and the row stay consistent.
      const { ms, counter } = serverNormalizedStamp(sqlite);
      const stamp = new Date(ms);

      // When no explicit position is supplied, append at end of siblings.
      let position = input.position;
      if (position === undefined) {
        const parentId = input.parentId ?? null;
        const siblings = db
          .select({ position: folders.position })
          .from(folders)
          .where(
            parentId === null ? sql`${folders.parentId} IS NULL` : eq(folders.parentId, parentId),
          )
          .all();
        position = siblings.reduce((max, s) => Math.max(max, s.position), -1) + 1;
      }

      db.insert(folders)
        .values({
          id,
          name: input.name,
          parentId: input.parentId ?? null,
          position,
          createdAt: stamp,
          updatedAt: stamp,
          deviceId: input.deviceId ?? readSkybridgeDeviceId(sqlite) ?? null,
          localDeviceUuid: readLocalDeviceUuid(sqlite),
          lwwCounter: counter,
        })
        .run();

      emitSyncChange(sqlite, {
        entityType: 'folder',
        entityId: id,
        op: 'create',
        payload: {
          name: input.name,
          parent_id: input.parentId ?? null,
          position,
          created_at_ms: ms,
          updated_at_ms: ms,
          lww_counter: counter,
        },
        nowMs: ms,
      });

      const row = db.select().from(folders).where(eq(folders.id, id)).get();
      if (!row) throw new Error(`Failed to retrieve folder after creation: ${id}`);
      return row;
    })
    .immediate();
}

export function getFolder(db: OwlDatabase, id: string): Folder | null {
  return db.select().from(folders).where(eq(folders.id, id)).get() ?? null;
}

/** Return all folders, ordered by parent_id then position. Caller assembles tree. */
export function listFolders(db: OwlDatabase): Folder[] {
  return db
    .select()
    .from(folders)
    .orderBy(asc(folders.parentId), asc(folders.position), asc(folders.createdAt))
    .all();
}

/**
 * Throws if moving `id` under `newParentId` would create a cycle (i.e. the new
 * parent is `id` itself or any of its descendants).
 */
function assertNoCycle(db: OwlDatabase, id: string, newParentId: string): void {
  if (newParentId === id) throw new Error('Cannot move folder into itself');
  let cursor: string | null = newParentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === id) throw new Error('Cannot move folder into its own descendant');
    if (seen.has(cursor)) break; // defensive: existing corruption, avoid infinite loop
    seen.add(cursor);
    const parent = db
      .select({ parentId: folders.parentId })
      .from(folders)
      .where(eq(folders.id, cursor))
      .get();
    cursor = parent?.parentId ?? null;
  }
}

export function updateFolder(
  db: OwlDatabase,
  sqlite: Database.Database,
  id: string,
  input: UpdateFolderInput,
): Folder | null {
  return sqlite
    .transaction(() => {
      const existing = db.select().from(folders).where(eq(folders.id, id)).get();
      if (!existing) return null;

      if (input.parentId !== undefined && input.parentId !== null) {
        assertNoCycle(db, id, input.parentId);
      }

      const { ms: nowMs, counter } = serverNormalizedStamp(sqlite);
      const updates: Record<string, unknown> = { updatedAt: new Date(nowMs), lwwCounter: counter };
      if (input.name !== undefined) updates.name = input.name;
      if (input.parentId !== undefined) updates.parentId = input.parentId;
      if (input.position !== undefined) updates.position = input.position;
      updates.deviceId =
        input.deviceId !== undefined ? input.deviceId : (readSkybridgeDeviceId(sqlite) ?? null);

      db.update(folders).set(updates).where(eq(folders.id, id)).run();

      // Sparse post-state payload: only the columns the caller asked to write
      // (plus updated_at_ms which always changes). device_id and content-style
      // hashes are derived server-side from sync_changes.device_id.
      const payload: Record<string, unknown> = { updated_at_ms: nowMs, lww_counter: counter };
      if (input.name !== undefined) payload.name = input.name;
      if (input.parentId !== undefined) payload.parent_id = input.parentId;
      if (input.position !== undefined) payload.position = input.position;

      emitSyncChange(sqlite, {
        entityType: 'folder',
        entityId: id,
        op: 'update',
        payload,
        nowMs,
      });

      return db.select().from(folders).where(eq(folders.id, id)).get() ?? null;
    })
    .immediate();
}

/**
 * Delete a folder and promote its direct children to its own parent (one level
 * up). Notes inside the deleted folder have `folder_id` reset to NULL via the
 * existing `ON DELETE SET NULL` FK.
 *
 * P4 Phase 2 ordering: SELECT children ids first, then UPDATE, then emit per-
 * child `folder/update` rows, then DELETE the folder, then emit `folder/delete`.
 * The SELECT-before-UPDATE order is mandatory — once UPDATE runs, the children
 * no longer match `parent_id = id` so we can't recover their ids.
 */
export function deleteFolder(db: OwlDatabase, sqlite: Database.Database, id: string): boolean {
  return sqlite
    .transaction(() => {
      const existing = db.select().from(folders).where(eq(folders.id, id)).get();
      if (!existing) return false;

      const grandparentId = existing.parentId;
      // W3: one stamp for the whole delete op (child reparenting + the delete
      // anchor). Distinct entity ids, so sharing (ms, counter) is fine — LWW
      // compares per-entity.
      const { ms: nowMs, counter } = serverNormalizedStamp(sqlite);
      const now = new Date(nowMs);

      const childIds = db
        .select({ id: folders.id })
        .from(folders)
        .where(eq(folders.parentId, id))
        .all()
        .map((r) => r.id);

      if (childIds.length > 0) {
        db.update(folders)
          .set({ parentId: grandparentId, updatedAt: now, lwwCounter: counter })
          .where(eq(folders.parentId, id))
          .run();
        for (const childId of childIds) {
          emitSyncChange(sqlite, {
            entityType: 'folder',
            entityId: childId,
            op: 'update',
            payload: { parent_id: grandparentId, updated_at_ms: nowMs, lww_counter: counter },
            nowMs,
          });
        }
      }

      const result = db.delete(folders).where(eq(folders.id, id)).run();
      if (result.changes === 0) return false;

      // P5-b §4.3: folder/delete payload carries updated_at_ms as the LWW
      // anchor — apply side compares this against local folders.updated_at to
      // decide whether to honour the delete or defer (mirrors note/delete
      // which got the same treatment in P5-a Step 0b).
      emitSyncChange(sqlite, {
        entityType: 'folder',
        entityId: id,
        op: 'delete',
        payload: { updated_at_ms: nowMs, lww_counter: counter },
        nowMs,
      });

      return true;
    })
    .immediate();
}

/** Apply a batch of (id, parentId, position) updates in a single transaction. */
export function reorderFolders(
  _db: OwlDatabase,
  sqlite: Database.Database,
  items: ReorderFolderItem[],
): number {
  if (items.length === 0) return 0;
  const stmt = sqlite.prepare(
    'UPDATE folders SET parent_id = ?, position = ?, updated_at = ?, lww_counter = ? WHERE id = ?',
  );
  const tx = sqlite.transaction((rows: ReorderFolderItem[]) => {
    // W3: one stamp for the batch reorder; distinct entity ids share it.
    const { ms, counter } = serverNormalizedStamp(sqlite);
    let count = 0;
    for (const row of rows) {
      const result = stmt.run(row.parentId, row.position, ms, counter, row.id);
      if (result.changes > 0) {
        count += result.changes;
        emitSyncChange(sqlite, {
          entityType: 'folder',
          entityId: row.id,
          op: 'update',
          payload: {
            parent_id: row.parentId,
            position: row.position,
            updated_at_ms: ms,
            lww_counter: counter,
          },
          nowMs: ms,
        });
      }
    }
    return count;
  });
  return tx(items);
}

/**
 * Return the ids of `folderId` and all of its descendants via a recursive CTE.
 * Used by note queries with `include_descendants=true`.
 */
export function getFolderSubtreeIds(sqlite: Database.Database, folderId: string): string[] {
  const rows = sqlite
    .prepare(
      `WITH RECURSIVE descendants(id) AS (
         SELECT id FROM folders WHERE id = ?
         UNION ALL
         SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id
       )
       SELECT id FROM descendants`,
    )
    .all(folderId) as { id: string }[];
  return rows.map((r) => r.id);
}
