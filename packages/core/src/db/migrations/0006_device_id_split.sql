-- 0006_device_id_split.sql — notes / folders 加 local_device_uuid 列 + 触发器（user_version = 6）
--
-- INVARIANT: 一旦 ship 本文件不可改。后续走 0007_*.sql。
--
-- 动机（P5-b §3.5）：P5-a 的 device_id 列写的是本机 local UUID，与未来从
-- skybridge 远端 apply 来的 deviceId（server 视角 device_id）语义冲突。
-- P5-b 拆两列：
--   notes/folders.local_device_uuid — "这行物理上躺在哪台 owl 安装"（本机视角）
--   notes/folders.device_id         — "这行最初由哪个 skybridge device 贡献"（远端视角）
--
-- 走 ADD COLUMN + backfill + 触发器路径，**不**做表重建（表重建会触发
-- note_tags / reminder_status 的 ON DELETE CASCADE，清空关联表 ——
-- 0001_initial.sql:48 / :59）。
--
-- `device_id` 列早就 nullable（schema.ts:15 / :33），不需要改 constraint。
-- 旧值（本机 local UUID）保留在 migration 里不动；由 daemon 的
-- ensureSkybridgeSession 拿到真正的 skybridge device id 后做非破坏性
-- backfill（设计文档 §6.1）。
--
-- `PRAGMA user_version = 6` 不在这里设 —— applyForwardMigrations() 跑完
-- 整个文件后才 stamp，与 0001-0005 一致。

-- ── 兜底：device_uuid 行必须存在（migration 可能在 ensureDeviceId 前跑） ──

INSERT OR IGNORE INTO local_metadata(key, value)
  VALUES ('device_uuid', lower(hex(randomblob(16))));

-- ── ADD COLUMN（注：SQLite 不允许 ADD COLUMN NOT NULL 给已有行的表，
--    所以这里加 nullable，由 backfill + 触发器联手保证非空） ──

ALTER TABLE notes   ADD COLUMN local_device_uuid TEXT;
ALTER TABLE folders ADD COLUMN local_device_uuid TEXT;

-- ── 回填现有行 ──

UPDATE notes
SET local_device_uuid = (SELECT value FROM local_metadata WHERE key = 'device_uuid')
WHERE local_device_uuid IS NULL;

UPDATE folders
SET local_device_uuid = (SELECT value FROM local_metadata WHERE key = 'device_uuid')
WHERE local_device_uuid IS NULL;

-- ── 触发器：INSERT 和 UPDATE 都拦下 local_device_uuid IS NULL ──
--
-- INSERT 触发器无可疑：NEW.local_device_uuid 必须非空。
-- UPDATE 触发器用 OF local_device_uuid 限定，只在该列被显式 SET 时检查，
-- 普通 row update 不触发这条 trigger。

CREATE TRIGGER notes_local_device_uuid_not_null_insert
BEFORE INSERT ON notes
WHEN NEW.local_device_uuid IS NULL
BEGIN
  SELECT RAISE(ABORT, 'notes.local_device_uuid must not be null');
END;

CREATE TRIGGER notes_local_device_uuid_not_null_update
BEFORE UPDATE OF local_device_uuid ON notes
WHEN NEW.local_device_uuid IS NULL
BEGIN
  SELECT RAISE(ABORT, 'notes.local_device_uuid must not be set to null');
END;

CREATE TRIGGER folders_local_device_uuid_not_null_insert
BEFORE INSERT ON folders
WHEN NEW.local_device_uuid IS NULL
BEGIN
  SELECT RAISE(ABORT, 'folders.local_device_uuid must not be null');
END;

CREATE TRIGGER folders_local_device_uuid_not_null_update
BEFORE UPDATE OF local_device_uuid ON folders
WHEN NEW.local_device_uuid IS NULL
BEGIN
  SELECT RAISE(ABORT, 'folders.local_device_uuid must not be set to null');
END;
