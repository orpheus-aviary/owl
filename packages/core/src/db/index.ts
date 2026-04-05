import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createFts } from './fts.js';
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
 * Initialize the owl database:
 * 1. Open SQLite with better-sqlite3
 * 2. Enable WAL mode + foreign keys
 * 3. Create tables from SQL DDL
 * 4. Create FTS5 virtual table + triggers
 * 5. Return drizzle ORM instance
 */
export function createDatabase(options: DatabaseOptions): {
  db: OwlDatabase;
  sqlite: BetterSqlite3.Database;
} {
  const { dbPath, wal = true, foreignKeys = true } = options;

  const sqlite = new BetterSqlite3(dbPath);

  if (wal) {
    sqlite.pragma('journal_mode = WAL');
  }
  if (foreignKeys) {
    sqlite.pragma('foreign_keys = ON');
  }
  sqlite.pragma('busy_timeout = 5000');

  createTables(sqlite);
  createFts(sqlite);

  const db = drizzle(sqlite, { schema });

  return { db, sqlite };
}

function createTables(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(DDL);
}

const DDL = `
  CREATE TABLE IF NOT EXISTS folders (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    parent_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    device_id   TEXT
  );

  CREATE TABLE IF NOT EXISTS notes (
    id            TEXT PRIMARY KEY,
    folder_id     TEXT REFERENCES folders(id) ON DELETE SET NULL,
    trash_level   INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    trashed_at    INTEGER,
    device_id     TEXT,
    content_hash  TEXT,
    content       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tags (
    id         TEXT PRIMARY KEY,
    tag_type   TEXT NOT NULL,
    tag_value  TEXT,
    UNIQUE(tag_type, tag_value)
  );

  CREATE TABLE IF NOT EXISTS note_tags (
    note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id   TEXT NOT NULL REFERENCES tags(id),
    PRIMARY KEY (note_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS local_metadata (
    key    TEXT PRIMARY KEY,
    value  TEXT
  );
`;

export { schema };
export { updateFtsTagsText } from './fts.js';
