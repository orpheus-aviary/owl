# P5-c M1-M8 手动验收发现的 bug 清单

> 2026-05-25 跑 `docs/plans/2026-05-24-p5-c-manual-checklist.md` 时发现的回归/遗漏。
> 每条带优先级 + 重现 + 临时缓解。修完一条把 status 改 ✅。

---

## #1 — `GET /tags` 路由没走 G6 过滤（M2 暴露）✅ 已修

**优先级**：P1（影响 GUI 浏览页标签筛选下拉的常态体验）

**症状**：M2 验收时把 3 条 `#完全没人用` 全部 trash，GUI 标签筛选下拉里 `#完全没人用` 还是出现；TagBar 弹窗同样。

**根因**：G6 fix（commit `cf19e2f`）只改了 `packages/core/src/tags/list.ts:listHashtagTags()`，但 daemon HTTP `GET /tags` route（`packages/daemon/src/routes/tags.ts:9-22`）从来不调 `listHashtagTags`，而是直接用 drizzle 在 `schema.tags` 上 select，没 JOIN `note_tags + notes`、没 trash 过滤。整条 GUI autocomplete / 浏览页标签筛选都命中这条 route。

**fix**：把 `/tags` 路由改成走原生 SQL JOIN `note_tags → notes`（`AND n.trash_level = 0`）+ `GROUP BY t.id HAVING COUNT(nt.note_id) > 0`；保留 `{id, tagType, tagValue}` payload 形状不动 GUI Tag interface。配套 regression test：`packages/daemon/src/server.test.ts` 加 "GET /tags excludes hashtags whose only notes are trashed"，create → 见 → trash → 不见 → restore → 又见 → search 仍生效。

**状态**：本 session 已在工作树修完，未 commit（等 M1-M8 全部跑完一起 commit）。

---

## #2 — sync engine 老 note 缺 CREATE op，新设备 bootstrap 拉不全（M5 准备阶段暴露）✅ 已修

**优先级**：P0（多设备同步的数据完整性核心 bug；0.5.0 / P5-d 之前必修）

**症状**：M5 准备 profile B（全新 nest）跑 `POST /sync/run` 拉 A 全量 → `pulledTotal=316 / appliedTotal=117 / skippedTotal=199 / conflictsRecorded=47`，B 上 live notes 只有 45 条，A 上是 58 条。**A 上 13 条 live note 在 B 上完全不存在**，比如「续费和维护」「gitea 配置」「API KEY」「MinIO Console 网盘」等真实用户笔记。daemon log 里大量 `[sync] pull skip note metadata op (no updated_at_ms) id=... op=update seq=...` 警告。

**根因**：这些 note 在 P4（sync_changes 写入机制上线）**之前**就已经在 owl.db 里。P4 落地时**只挂触发器追后续 mutation，没有 backfill 历史数据生成 `create` op 到 sync_changes**。所以这些 note 在 A 的 sync_changes 里只有零散的 `update` / `pin`（用户后来改过才追的），从来没有 `create`。新设备 B bootstrap 时按 server seq 顺序 apply ops，收到 `update` 找不到对应 note → 走 `skip note metadata op` 分支默默丢弃。**单设备运行不出问题**（A 直接读 notes 表，跟 sync_changes 无关），所以 P4/P5-a/P5-b 全程没暴露；只有真起第二台设备才崩。

**Audit 数据**（A nest）：
- live notes = 58；其中 `✅ 至少 push 过`（sync_changes 有 row 且 `synced_at IS NOT NULL`）= 18，`❌ 从来没 push 过`（sync_changes 完全没 row）= 40
- 18 条 pushed 里很多只有 update / pin op，没 create，所以 B 上 apply 失败
- 例：`f42b01e3`（续费和维护）9 op 全 update + 1 pin，没 create；`054478aa`（MinIO）10 op 全 update
- B 拉时 47 个 conflict 全是 bootstrap noise（local `"# \n\n"` 空壳 vs remote 真实内容）—— 本 session M5 准备时已 `UPDATE conflict_record SET resolved_at=..., resolution='ignored'` 清掉

**临时缓解**（本 session 用户验证 M5/M6/M7/M8 不受影响）：
- A 上真实数据 0 影响（trash_level=0、content 完整、`*.db.pre-p3-4-*` 备份也都在）
- 缺失只在 B 这个**测试 nest**上 —— M6/M7/M8 也不依赖 B 数据完整性
- 用户暂不需要任何手动恢复操作

**修法（本 session 已完成，commit `3d911d4`）**：
1. ✅ schema v8 migration `0008_backfill_create_ops.sql` 扫 notes / folders 表，对没有 `create` op 的 row 追写一条，payload 用当前快照。folders backfill 先于 notes（保 FK 顺序），SPECIAL_NOTES.MEMO / TODO 不补（每台设备本地 materialise），conversations 不补（apply 端会自动 INSERT）
2. ✅ engine apply pull 加 `PRAGMA defer_foreign_keys = ON`（防御性，应对真用户 push 顺序乱掉）
3. ✅ `maybeRecordNoteConflict` 加 `EXISTS sync_changes` 闸门 —— 没本地编辑过的 entity 不记 conflict，消除 bootstrap noise（M5 重测时 49 个 false conflict → 0）
4. ✅ 0008 单测 8 case：legacy / legacy-with-update / modern / SPECIAL / folder / idempotent / device_uuid 覆盖；engine 加 "bootstrap replay" 新单测
5. ✅ 手动回归通过：A 58/71/7 → B wiped + re-bootstrap → 58/71/7，0 conflicts

---

## #3 — `[object Object] sync HTTP retry scheduled` log 模板没序列化（M6 暴露）✅ 已修

**优先级**：P3（不影响功能，只影响 debug 体验）

**症状**：M6 验收时盯 daemon.log，每次 `sync` retry 都打：
```
{"level":40,...,"kind":"sync","msg":"[object Object] sync HTTP retry scheduled"}
```
`[object Object]` 字面出现在 msg 里 —— 模板字符串拼了一个 Error / 上下文对象但没结构化展开。每次 scheduler tick 5 个 retry，连续 5 行噪音，看不到 attempt index / backoff delay / cause。

**根因**：`packages/core/src/sync/retry.ts:withRetry` 已经走 pino-style `logger.warn({ kind, attempt, of, waitMs }, msg)` 调用，但 `packages/daemon/src/sync/manual.ts` 包了一层 shim：
```ts
warn: (...a) => ctx.logger.warn({ kind: 'sync' }, a.map(String).join(' ')),
```
`a.map(String)` 把第一个 object arg 字面转 `[object Object]`，结构化字段全丢，所有 retry 详情连带 `attempt` / `waitMs` / `cause` 都看不到。

**修法（commit `c8d20e1`）**：抽 `emitSyncLog(emit, args)`，sniff 调用形状：object 头 + optional string msg → 合并到结构化 payload；其它 fall back 老路径。带 7-case 单测覆盖。

**状态**：✅ 已修。

---
