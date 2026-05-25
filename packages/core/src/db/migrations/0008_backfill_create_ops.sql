-- 0008_backfill_create_ops.sql — backfill sync_changes `create` op for legacy
-- notes / folders that pre-date the P4 outbox trigger (user_version = 8)
--
-- INVARIANT: 一旦 ship 本文件不可改。后续走 0009_*.sql。
--
-- 动机（P5-c manual M5 暴露，bugs.md #2）：
-- P4 在 0005 上线 sync_changes 触发器时只挂了 mutation 追加，没有 backfill
-- 历史行的 `create` op。结果是：早于 P4 创建、之后被用户改过的 note 在
-- sync_changes 里只有零散 `update` / `pin` op，缺 `create`。单设备读
-- 不出问题（直接读 notes 表），新设备 bootstrap 时按 server_seq 顺序 apply：
--   - 收到 `update` 找不到 local row → 走 engine.ts:423 "local row missing,
--     skipped (P5-a)" 分支默默丢弃
--   - 永远拿不到这条 note
-- 真实代价：2026-05-25 manual M5 验证时，profile B 全新 nest sync 一次后
-- live notes 数 = 45，A 是 58，丢 13 条真实用户笔记。
--
-- 修法：扫 notes / folders 表，对每条没有对应 `op='create'` 在 sync_changes
-- 里的 row，追写一条 create + current snapshot。client_change_id 用
-- `randomblob(16)` 跟 0005 一致；server_seq / synced_at 留 NULL，下次
-- `/sync/run` 把它们 push 上 server。
--
-- 系统 note (SPECIAL_NOTES.MEMO / TODO, db/special-notes.ts) 排除 —— 这俩
-- 每台设备由 `ensureSpecialNotes` 本地创建，固定 id 跨设备相同，无需 sync。
-- 同步 SPECIAL_NOTES.id 反而会让两端互相覆盖。
--
-- conversations 不补 —— `applyConversationAppend` 在 missing-row 时会
-- INSERT INTO ai_conversations（engine.ts:581），第一条 `append` 自动建表行。
--
-- `PRAGMA user_version = 8` 不在这里设 —— applyForwardMigrations() 跑完
-- 整个文件后才 stamp。

-- ── folders backfill (FIRST — note.folder_id FK to folders) ───────────
--
-- Order matters: AUTOINCREMENT assigns local_seq in INSERT order, push
-- uploads in local_seq order, so folder creates get LOWER server_seq
-- than note creates. On the pulling side this means folders apply
-- first, so a note carrying folder_id won't fail the FK. The pull
-- transaction also runs `PRAGMA defer_foreign_keys = ON`
-- (engine.ts:applyPullLoop) so even if a real-user push reverses the
-- order, FK still resolves at COMMIT — this section ordering is
-- defense in depth.

INSERT INTO sync_changes (
  device_id, entity_type, entity_id, op, payload, created_at,
  client_change_id, server_seq, synced_at
)
SELECT
  COALESCE((SELECT value FROM local_metadata WHERE key='device_uuid'), f.device_id, ''),
  'folder',
  f.id,
  'create',
  json_object(
    'name',          f.name,
    'parent_id',     f.parent_id,
    'position',      f.position,
    'created_at_ms', f.created_at,
    'updated_at_ms', f.updated_at
  ),
  cast(strftime('%s','now') AS INTEGER) * 1000,
  lower(hex(randomblob(16))),
  NULL,
  NULL
FROM folders f
WHERE NOT EXISTS (
  SELECT 1 FROM sync_changes sc
  WHERE sc.entity_type = 'folder'
    AND sc.entity_id   = f.id
    AND sc.op          = 'create'
);

-- ── notes backfill ─────────────────────────────────────────────────────

INSERT INTO sync_changes (
  device_id, entity_type, entity_id, op, payload, created_at,
  client_change_id, server_seq, synced_at
)
SELECT
  COALESCE((SELECT value FROM local_metadata WHERE key='device_uuid'), n.device_id, ''),
  'note',
  n.id,
  'create',
  json_object(
    'content',       n.content,
    'folder_id',     n.folder_id,
    'trash_level',   n.trash_level,
    'created_at_ms', n.created_at,
    'updated_at_ms', n.updated_at,
    'tags', COALESCE(
      (SELECT json_group_array(json_object('tag_type', t.tag_type, 'tag_value', t.tag_value))
         FROM note_tags nt
         JOIN tags t ON nt.tag_id = t.id
        WHERE nt.note_id = n.id),
      json('[]')
    )
  ),
  cast(strftime('%s','now') AS INTEGER) * 1000,
  lower(hex(randomblob(16))),
  NULL,
  NULL
FROM notes n
WHERE n.id NOT IN (
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000002'
      )
  AND NOT EXISTS (
    SELECT 1 FROM sync_changes sc
    WHERE sc.entity_type = 'note'
      AND sc.entity_id   = n.id
      AND sc.op          = 'create'
  );
