-- 0010_special_notes_seed_ts.sql — deterministic timestamps for pristine
-- special notes (user_version = 10)
--
-- INVARIANT: 一旦 ship 本文件不可改。后续走 0011_*.sql。
--
-- 动机（Problem A / Phase 4）：
-- 随记 / 待办（SPECIAL_NOTES.MEMO / TODO）是**跨设备同步的用户数据**，但用固定
-- id 由每台设备 `ensureSpecialNotes` 本地播种，不走 sync（0008 也显式排除）。
-- 播种此前写 `Date.now()`，于是这个纯本地动作也参与了 LWW：
--
--   设备 A（昨天）真实编辑随记 → 推出 op(updated_at = 昨天)
--   设备 B（今天）首次启动播种 → 本地 updated_at = 今天
--   B 拉到 A 的 op → LWW 比较 今天 > 昨天 → **skip**，A 的内容永远到不了 B
--
-- 修法：播种改用常量 `SEED_TS = 0`（db/special-notes.ts），让 pristine seed
-- 在 LWW 上永远输给任何一次真实编辑。本迁移把**存量**的 pristine 行补齐。
--
-- 三道 WHERE 缺一不可：
--   1. `created_at = updated_at` —— 播种时两者相等；任何编辑只推高 updated_at。
--   2. 内容仍等于默认模板 —— 双保险。
--   3. 没有**改内容或 updated_at** 的 outbox 行。注意判据看 payload 而不是 op：
--      `setNotePinned`（payload `{pinned_at_ms}`）和 `reorderNotes`（payload
--      `{position}`）发的都是普通行，reorder 甚至 op 就是 'update'，但两者都
--      不碰 content / updated_at。只按 op 排除会把「只被置顶或拖动过的 pristine
--      seed」漏掉 —— 恰恰是仍需修的那批。真正的 `updateNote` 一定带
--      `updated_at_ms`（notes/index.ts buildNoteUpdatePayload）。
--
-- 已被编辑过的行一律不动：它们的时间戳是真实的，改了会破坏收敛。
--
-- `PRAGMA user_version = 10` 不在这里设 —— applyForwardMigrations() 跑完
-- 整个文件后才 stamp。

UPDATE notes SET created_at = 0, updated_at = 0, lww_counter = 0
WHERE id = '00000000-0000-0000-0000-000000000001'
  AND created_at = updated_at
  AND content = '# 随记' || char(10) || char(10)
  AND NOT EXISTS (
    SELECT 1 FROM sync_changes sc
     WHERE sc.entity_type = 'note' AND sc.entity_id = notes.id
       AND ( sc.op IN ('create','trash','restore','delete')
          OR ( sc.op = 'update'
               AND json_type(sc.payload, '$.updated_at_ms') IS NOT NULL ) ));

UPDATE notes SET created_at = 0, updated_at = 0, lww_counter = 0
WHERE id = '00000000-0000-0000-0000-000000000002'
  AND created_at = updated_at
  AND content = '# 待办' || char(10) || char(10) || '- [ ] '
  AND NOT EXISTS (
    SELECT 1 FROM sync_changes sc
     WHERE sc.entity_type = 'note' AND sc.entity_id = notes.id
       AND ( sc.op IN ('create','trash','restore','delete')
          OR ( sc.op = 'update'
               AND json_type(sc.payload, '$.updated_at_ms') IS NOT NULL ) ));
