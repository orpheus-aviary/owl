-- 0011_conflict_record_lww_key.sql — store the full LWW key on conflict rows
-- (user_version = 11)
--
-- INVARIANT: 一旦 ship 本文件不可改。后续走 0012_*.sql。
--
-- 动机（0.6.2 / W1）：
-- LWW 从 W3（0009）起就是三元组 (updated_at_ms, lww_counter, device_id)，但
-- `conflict_record` 只存了两个 ms 列（0007 建表、0009 注释里明确留账）。于是
-- 冲突页在「同一毫秒」的场景下解释不了谁赢：ms 相同时胜负由 counter 决定，
-- counter 也相同时由 device_id 字典序决定，而这两维表里都没有。
--
-- 本片把三元组补全（display-only，**LWW 判定逻辑零变化**）。四列全部 nullable：
-- 存量行确实没有这些信息，读取侧按「四列全 NULL = 老行」渲染成现状。
--
-- 空 device_id 的归一：`readLocalNoteLwwKey`（sync/lww.ts）把 NULL device 读成
-- `''` 以保持三元组全序，入库时 `'' → NULL`，读取侧统一按「未知设备」渲染。
--
-- ⚠️ `sync_changes` 自 0.6.2（W2 / retention.ts）起会被裁剪。**今后任何迁移都
-- 不得用「某实体在 sync_changes 里有没有历史行」做判断**（0008 那种存在性
-- backfill）。需要类似语义时改用业务表字段或 `local_metadata` 标记。
--
-- `PRAGMA user_version = 11` 不在这里设 —— applyForwardMigrations() 跑完
-- 整个文件后才 stamp。

ALTER TABLE conflict_record ADD COLUMN local_lww_counter  INTEGER;
ALTER TABLE conflict_record ADD COLUMN remote_lww_counter INTEGER;
ALTER TABLE conflict_record ADD COLUMN local_device_id    TEXT;
ALTER TABLE conflict_record ADD COLUMN remote_device_id   TEXT;
