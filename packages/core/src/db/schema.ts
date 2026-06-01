import { integer, primaryKey, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

// ─── Folders (adjacency list model) ────────────────────

export const folders = sqliteTable('folders', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentId: text('parent_id').references((): AnySQLiteColumn => folders.id, {
    onDelete: 'set null',
  }),
  position: integer('position', { mode: 'number' }).notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  deviceId: text('device_id'),
  // P5-b §3.5: 本机视角的"行在哪台 owl 装着"。SQL 端 NOT NULL 由
  // 0006 的 BEFORE INSERT / UPDATE 触发器兜底。
  localDeviceUuid: text('local_device_uuid').notNull(),
  // W3 (0009): per-device monotonic LWW tiebreaker. Paired with updated_at +
  // device_id to form the three-tuple LWW key. Legacy rows backfill 0.
  lwwCounter: integer('lww_counter', { mode: 'number' }).notNull().default(0),
});

// ─── Notes ─────────────────────────────────────────────

export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  folderId: text('folder_id').references(() => folders.id, { onDelete: 'set null' }),
  trashLevel: integer('trash_level', { mode: 'number' }).notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  trashedAt: integer('trashed_at', { mode: 'timestamp_ms' }),
  /**
   * Sticky auto-delete deadline for trash_level=2 notes.
   * Can only move earlier (never later) when the threshold config changes —
   * see `recomputeTrashDeadlines`. NULL means "not yet in level-2 trash".
   */
  autoDeleteAt: integer('auto_delete_at', { mode: 'timestamp_ms' }),
  deviceId: text('device_id'),
  contentHash: text('content_hash'),
  content: text('content').notNull(),
  // NULL = not pinned. Timestamp recorded when the user pins the note.
  // setNotePinned() must NOT touch updated_at — pin is metadata, not content.
  pinnedAt: integer('pinned_at', { mode: 'timestamp_ms' }),
  // Per-folder manual sort key. NULL until the user reorders notes in that
  // folder; first reorder materialises positions as 1000, 2000, 3000, ...
  position: real('position'),
  // P5-b §3.5: 本机视角的"行在哪台 owl 装着"。SQL 端 NOT NULL 由
  // 0006 的 BEFORE INSERT / UPDATE 触发器兜底。
  localDeviceUuid: text('local_device_uuid').notNull(),
  // W3 (0009): per-device monotonic LWW tiebreaker. Paired with updated_at +
  // device_id to form the three-tuple LWW key. Legacy rows backfill 0.
  lwwCounter: integer('lww_counter', { mode: 'number' }).notNull().default(0),
});

// ─── Tags ──────────────────────────────────────────────

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey(),
    tagType: text('tag_type').notNull(),
    tagValue: text('tag_value'),
  },
  (table) => [unique('tags_type_value_uniq').on(table.tagType, table.tagValue)],
);

// ─── Note ↔ Tag join table ─────────────────────────────

export const noteTags = sqliteTable(
  'note_tags',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id),
  },
  (table) => [primaryKey({ columns: [table.noteId, table.tagId] })],
);

// ─── Local metadata (owl.db only, excluded from sync) ──

export const localMetadata = sqliteTable('local_metadata', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// ─── Reminder Status (alarm scheduling persistence) ───

export const reminderStatus = sqliteTable(
  'reminder_status',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id),
    fireAt: integer('fire_at', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('pending'),
    firedAt: integer('fired_at', { mode: 'number' }),
  },
  (table) => [primaryKey({ columns: [table.noteId, table.tagId] })],
);
