import type Database from 'better-sqlite3';
import { asc, eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { OwlDatabase } from '../db/index.js';
import { folders } from '../db/schema.js';

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

export function createFolder(db: OwlDatabase, input: CreateFolderInput): Folder {
  const id = uuidv4();
  const now = new Date();

  // When no explicit position is supplied, append at end of siblings.
  let position = input.position;
  if (position === undefined) {
    const parentId = input.parentId ?? null;
    const siblings = db
      .select({ position: folders.position })
      .from(folders)
      .where(parentId === null ? sql`${folders.parentId} IS NULL` : eq(folders.parentId, parentId))
      .all();
    position = siblings.reduce((max, s) => Math.max(max, s.position), -1) + 1;
  }

  db.insert(folders)
    .values({
      id,
      name: input.name,
      parentId: input.parentId ?? null,
      position,
      createdAt: now,
      updatedAt: now,
      deviceId: input.deviceId ?? null,
    })
    .run();

  const row = db.select().from(folders).where(eq(folders.id, id)).get();
  if (!row) throw new Error(`Failed to retrieve folder after creation: ${id}`);
  return row;
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

export function updateFolder(db: OwlDatabase, id: string, input: UpdateFolderInput): Folder | null {
  const existing = db.select().from(folders).where(eq(folders.id, id)).get();
  if (!existing) return null;

  if (input.parentId !== undefined && input.parentId !== null) {
    assertNoCycle(db, id, input.parentId);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.parentId !== undefined) updates.parentId = input.parentId;
  if (input.position !== undefined) updates.position = input.position;
  if (input.deviceId !== undefined) updates.deviceId = input.deviceId;

  db.update(folders).set(updates).where(eq(folders.id, id)).run();
  return db.select().from(folders).where(eq(folders.id, id)).get() ?? null;
}

/**
 * Delete a folder and promote its direct children to its own parent (one level
 * up). Notes inside the deleted folder have `folder_id` reset to NULL via the
 * existing `ON DELETE SET NULL` FK.
 */
export function deleteFolder(db: OwlDatabase, id: string): boolean {
  const existing = db.select().from(folders).where(eq(folders.id, id)).get();
  if (!existing) return false;

  const grandparentId = existing.parentId;
  db.update(folders)
    .set({ parentId: grandparentId, updatedAt: new Date() })
    .where(eq(folders.parentId, id))
    .run();

  const result = db.delete(folders).where(eq(folders.id, id)).run();
  return result.changes > 0;
}

/** Apply a batch of (id, parentId, position) updates in a single transaction. */
export function reorderFolders(
  _db: OwlDatabase,
  sqlite: Database.Database,
  items: ReorderFolderItem[],
): number {
  if (items.length === 0) return 0;
  const now = Date.now();
  const stmt = sqlite.prepare(
    'UPDATE folders SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?',
  );
  const tx = sqlite.transaction((rows: ReorderFolderItem[]) => {
    let count = 0;
    for (const row of rows) {
      const result = stmt.run(row.parentId, row.position, now, row.id);
      count += result.changes;
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
