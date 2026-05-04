-- 0002_sorting.sql — add pinned_at + position to notes (user_version = 2)
--
-- INVARIANT: Once shipped, this file is IMMUTABLE. Do not edit after v0.4.0.
-- Future schema changes go into 0003_*.sql, 0004_*.sql, ...
--
-- `PRAGMA user_version = 2` is NOT set here — applyForwardMigrations() stamps
-- it after this file succeeds. Same convention as 0001_initial.sql.
--
-- Non-destructive migration: pure ALTER TABLE ADD COLUMN (O(1) in SQLite).
-- Existing rows get pinned_at = NULL, position = NULL; default sort behaviour
-- is unchanged until users explicitly pin/reorder.

ALTER TABLE notes ADD COLUMN pinned_at INTEGER;   -- NULL = not pinned; ms timestamp when pinned
ALTER TABLE notes ADD COLUMN position  REAL;      -- per-folder manual sort key (NULL until user reorders)

-- Serves POST /notes/reorder validation (fetch all rows in a folder) and any
-- future per-folder list queries. FolderPanel currently pulls the full notes
-- table once and groups client-side, so it does not use this index today.
CREATE INDEX idx_notes_folder_position
  ON notes(trash_level, folder_id, position, updated_at);
