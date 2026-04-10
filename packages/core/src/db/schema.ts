import { integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
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
});

// ─── Notes ─────────────────────────────────────────────

export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  folderId: text('folder_id').references(() => folders.id, { onDelete: 'set null' }),
  trashLevel: integer('trash_level', { mode: 'number' }).notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  trashedAt: integer('trashed_at', { mode: 'timestamp_ms' }),
  deviceId: text('device_id'),
  contentHash: text('content_hash'),
  content: text('content').notNull(),
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
