-- 0005_sync_change_outbox.sql — sync_changes 行加 outbox 状态列（user_version = 5）
--
-- INVARIANT: 一旦 ship 本文件不可改。后续走 0006_*.sql。
--
-- 动机：P5-a sync engine 需要 per-row clientChangeId / server_seq /
-- synced_at 来支撑 push 确认与重放语义。schema v4 的 sync_changes 只够
-- emit，不够 push。
--
-- `PRAGMA user_version = 5` 不在这里设 —— applyForwardMigrations() 跑完
-- 整个文件后才 stamp，与 0001/0002/0003/0004 保持一致。

-- ── 新列 ──────────────────────────────────────────────────────────────

ALTER TABLE sync_changes ADD COLUMN client_change_id TEXT;
ALTER TABLE sync_changes ADD COLUMN server_seq        INTEGER;
ALTER TABLE sync_changes ADD COLUMN synced_at         INTEGER;

-- ── 回填 v4 旧行 ─────────────────────────────────────────────────────
--
-- P4 Phase 2 已累积的本地 sync_changes 行没有 client_change_id；新发出的
-- push 需要 cid 才能让 server 做幂等。这里用 randomblob+hex 拼一个
-- 32 字符 lowercase hex id，足够唯一（sqlite 没有原生 uuid 函数）。

UPDATE sync_changes
SET client_change_id = lower(hex(randomblob(16)))
WHERE client_change_id IS NULL;

-- v4 时代 permanentDeleteNote emit 的 payload 是 `{}`，缺 updated_at_ms。
-- Step 0b 之后新行 OK，但 v4 库里堆积的旧 delete 行需要 backfill：用
-- created_at 当 fallback updated_at_ms。这样首次 push 上去的 delete
-- change 不会因为对端 apply 验证缺字段而崩。其它 op 已经在 emit 端
-- 携带 updated_at_ms（参 emit 源码注释 notes/index.ts:387），无需 backfill。

UPDATE sync_changes
SET payload = json_object('updated_at_ms', created_at)
WHERE entity_type = 'note'
  AND op = 'delete'
  AND payload = '{}';

-- ── 索引 ──────────────────────────────────────────────────────────────

-- cid 应用层用 randomUUID() 生成，碰撞概率忽略；UNIQUE 索引让 "按 cid
-- 回填 server_seq" 的 UPDATE 永远只命中一行（防御性）。
CREATE UNIQUE INDEX idx_sync_changes_cid ON sync_changes(client_change_id);

-- 加速 "找出所有 pending push" 的查询。partial index：仅索引未确认行。
CREATE INDEX idx_sync_changes_pending
  ON sync_changes(synced_at)
  WHERE synced_at IS NULL;
