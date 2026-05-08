-- 0004_skybridge_tables.sql — sync_changes / sync_cursor / conflict_record (user_version = 4)
--
-- INVARIANT: Once shipped, this file is IMMUTABLE. Forward changes go into
-- 0005_*.sql, ... never edit.
--
-- P4 Phase 2: introduce the local change-log spine that skybridge sync
-- engine (Phase 3) will push/pull. Phase 2 only writes to `sync_changes`;
-- `sync_cursor` and `conflict_record` are scaffolded so Phase 3 (sync engine)
-- and Phase 5 (conflict UI) don't need a follow-up migration. Both stay
-- empty until those phases land.
--
-- Non-destructive: pure CREATE TABLE + CREATE INDEX. Existing data untouched.
--
-- `PRAGMA user_version = 4` is NOT set here — applyForwardMigrations() stamps
-- it after this file succeeds. Same convention as 0001/0002/0003.

CREATE TABLE sync_changes (
  local_seq    INTEGER PRIMARY KEY AUTOINCREMENT,  -- strict monotonic, never reused
  device_id    TEXT NOT NULL,                       -- origin device UUID (from local_metadata.device_uuid)
  entity_type  TEXT NOT NULL,                       -- 'note' | 'folder' | 'conversation' (Phase 2 set)
  entity_id    TEXT NOT NULL,                       -- id in business table; '' if global
  op           TEXT NOT NULL,                       -- 'create' | 'update' | 'trash' | 'restore' | 'delete' | 'pin' | 'append'
  payload      TEXT NOT NULL,                       -- JSON; shape depends on (entity_type, op) — see Phase 2 design doc
  created_at   INTEGER NOT NULL                     -- Unix ms when the local mutation committed
);

CREATE INDEX idx_sync_changes_created ON sync_changes(created_at);

-- Phase 3 placeholder. Empty in Phase 2; sync engine reads/writes after first push/pull.
CREATE TABLE sync_cursor (
  endpoint    TEXT PRIMARY KEY,        -- server URL or logical endpoint id
  pulled_seq  INTEGER NOT NULL DEFAULT 0,
  pushed_seq  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- Phase 5 placeholder. Empty in Phase 2.
CREATE TABLE conflict_record (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  local_seq    INTEGER,
  remote_seq   INTEGER,
  detected_at  INTEGER NOT NULL,
  resolved_at  INTEGER,
  resolution   TEXT
);
