-- 0009_lww_counter.sql — W3 HLC-lite per-row LWW tiebreaker (user_version = 9)
--
-- INVARIANT: 一旦 ship 本文件不可改。后续走 0010_*.sql。
--
-- 动机（Phase 16c / W3）：
-- LWW 此前只比 updated_at_ms。两个问题：
--   1. 错钟设备（系统时钟拨快）写出的 updated_at 恒大，单方面压制全网；
--   2. 同一设备在同一毫秒内连续编辑两次，第二次被对端 `>=` 当成「不更新」丢弃。
-- 修法：给 notes / folders 加 per-device 单调 counter，LWW 比较升为三元
-- (updated_at_ms, lww_counter, device_id) 全序。stamp 由 sync/hlc.ts
-- serverNormalizedStamp 生成（server 归一化 ms + 物理不前进则 counter++）。
--
-- 旧行回填 0：pre-W3 语义 counter 恒为 0，三元比较退化为
-- (updated_at_ms, device_id)，与旧库收敛一致、向后兼容。
--
-- conflict_record 的 counter 列本片不做（display-only，连带改 conflicts.ts
-- + GUI 类型/测试，与 LWW 正确性无关）—— 留 conflict UI 迭代 / 0.6（W7）。
--
-- `PRAGMA user_version = 9` 不在这里设 —— applyForwardMigrations() 跑完
-- 整个文件后才 stamp。

ALTER TABLE notes   ADD COLUMN lww_counter INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN lww_counter INTEGER NOT NULL DEFAULT 0;
