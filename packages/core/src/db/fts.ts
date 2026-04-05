import type Database from 'better-sqlite3';

/**
 * FTS5 virtual table and triggers for full-text search.
 * - `content` column: auto-synced via triggers on INSERT/UPDATE/DELETE
 * - `tags_text` column: maintained by business layer (requires JOIN across tables)
 */

const FTS_TABLE = `
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    content,
    tags_text,
    content=notes,
    content_rowid=rowid,
    tokenize='trigram'
  );
`;

const FTS_TRIGGER_INSERT = `
  CREATE TRIGGER IF NOT EXISTS notes_fts_insert AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, content, tags_text)
    VALUES (new.rowid, new.content, '');
  END;
`;

const FTS_TRIGGER_DELETE = `
  CREATE TRIGGER IF NOT EXISTS notes_fts_delete AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, content, tags_text)
    VALUES ('delete', old.rowid, old.content, '');
  END;
`;

const FTS_TRIGGER_UPDATE = `
  CREATE TRIGGER IF NOT EXISTS notes_fts_update AFTER UPDATE OF content ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, content, tags_text)
    VALUES ('delete', old.rowid, old.content, '');
    INSERT INTO notes_fts(rowid, content, tags_text)
    VALUES (new.rowid, new.content, '');
  END;
`;

export function createFts(db: Database.Database): void {
  db.exec(FTS_TABLE);
  db.exec(FTS_TRIGGER_INSERT);
  db.exec(FTS_TRIGGER_DELETE);
  db.exec(FTS_TRIGGER_UPDATE);
}

/**
 * Update tags_text for a specific note in the FTS index.
 * Called by business layer after tag changes.
 */
export function updateFtsTagsText(
  db: Database.Database,
  noteRowid: number,
  tagsText: string,
): void {
  const note = db.prepare('SELECT content FROM notes WHERE rowid = ?').get(noteRowid) as
    | { content: string }
    | undefined;
  if (!note) return;

  db.prepare(
    "INSERT INTO notes_fts(notes_fts, rowid, content, tags_text) VALUES ('delete', ?, ?, ?)",
  ).run(noteRowid, note.content, '');
  db.prepare('INSERT INTO notes_fts(rowid, content, tags_text) VALUES (?, ?, ?)').run(
    noteRowid,
    note.content,
    tagsText,
  );
}
