-- 0001_initial.sql — owl database baseline schema (user_version = 1)
--
-- INVARIANT: Once shipped, this file is IMMUTABLE. Forward schema changes go
-- into 0002_*.sql, 0003_*.sql, ... never edit an already-released migration.
-- The migration runner relies on re-running 0001 on fresh installs and
-- assumes its SQL has not drifted from what v0.3.0 originally shipped.
--
-- The `notes.auto_delete_at` column intentionally sits at the end of the
-- column list to match the physical column order of v0.2 legacy databases
-- (where it was added via ALTER TABLE). Keeping the order identical means
-- users who survived the v0.2 -> v0.3 rebuild have the same byte layout as
-- fresh-install users, which simplifies future migration audits.
--
-- `PRAGMA user_version = 1` is NOT set here — the runner sets it after
-- applying this file. This keeps schema SQL files free of version bookkeeping.

CREATE TABLE folders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  device_id   TEXT
);

CREATE TABLE notes (
  id             TEXT PRIMARY KEY,
  folder_id      TEXT REFERENCES folders(id) ON DELETE SET NULL,
  trash_level    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  trashed_at     INTEGER,
  device_id      TEXT,
  content_hash   TEXT,
  content        TEXT NOT NULL,
  auto_delete_at INTEGER
);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  tag_type   TEXT NOT NULL,
  tag_value  TEXT,
  UNIQUE(tag_type, tag_value)
);

CREATE TABLE note_tags (
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (note_id, tag_id)
);

CREATE TABLE local_metadata (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

CREATE TABLE reminder_status (
  note_id   TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES tags(id),
  fire_at   INTEGER NOT NULL,
  status    TEXT NOT NULL DEFAULT 'pending',
  fired_at  INTEGER,
  PRIMARY KEY (note_id, tag_id)
);

CREATE VIRTUAL TABLE notes_fts USING fts5(
  content,
  tags_text,
  content=notes,
  content_rowid=rowid,
  tokenize='trigram'
);

CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, content, tags_text)
  VALUES (new.rowid, new.content, '');
END;

CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content, tags_text)
  VALUES ('delete', old.rowid, old.content, '');
END;

CREATE TRIGGER notes_fts_update AFTER UPDATE OF content ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content, tags_text)
  VALUES ('delete', old.rowid, old.content, '');
  INSERT INTO notes_fts(rowid, content, tags_text)
  VALUES (new.rowid, new.content, '');
END;
