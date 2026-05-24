-- 0007_conflict_record_payload.sql — conflict_record 加 losing_side / payload 副本 / 时间戳 + 未解决 partial index (user_version = 7)
--
-- INVARIANT: 一旦 ship 本文件不可改。后续走 0008_*.sql。
--
-- 动机（P5-c §2.4 / §6.16-§6.18）：0004 占位时只有 id / entity_* / *_seq /
-- detected_at / resolved_at / resolution，没法在 UI 里展示"输的那一份本地内容长什么样"。
-- P5-c A 阶段写 conflict 时把 losing local snapshot + winning remote payload + 双方
-- updated_at_ms 都存进来，GUI 显示「副本」+ 时间戳对比。
--
-- 5 列全部 nullable：旧的 P4 占位行（实际上应该全空）payload 字段为 NULL，
-- GUI 渲染 "(无副本)"；新写入的行由 `sync/conflicts.ts:recordConflict` 填齐。
--
-- 走纯 ADD COLUMN + CREATE INDEX 路径，不重建表。
--
-- `losing_side` / `resolution` 都是 TEXT 开放 enum（无 CHECK），校验只在 TS 层；
-- B/C 阶段加 'restored' / 'merged' 值不需要 migration（设计 §6.18）。
--
-- `idx_conflict_unresolved` 是 partial index：sidebar 红点 count(*) WHERE
-- resolved_at IS NULL 走该 index，避免全表扫描（设计 §2.4）。
--
-- `PRAGMA user_version = 7` 不在这里设 —— applyForwardMigrations() 跑完后 stamp。

ALTER TABLE conflict_record ADD COLUMN losing_side          TEXT;
ALTER TABLE conflict_record ADD COLUMN local_payload        TEXT;
ALTER TABLE conflict_record ADD COLUMN remote_payload       TEXT;
ALTER TABLE conflict_record ADD COLUMN local_updated_at_ms  INTEGER;
ALTER TABLE conflict_record ADD COLUMN remote_updated_at_ms INTEGER;

CREATE INDEX idx_conflict_unresolved
  ON conflict_record(detected_at DESC)
  WHERE resolved_at IS NULL;
