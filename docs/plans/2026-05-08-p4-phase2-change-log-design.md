# P4 Phase 2 — 本地 change log design

日期：2026-05-08
状态：草案，开工前需用户确认 scope
父框架：`docs/plans/2026-05-07-p4-skybridge-plan.md`
前序：`docs/plans/2026-05-08-p4-phase1-entry-convergence-design.md`（已 ship）

## 目标

- schema v4：新增 `sync_changes` / `sync_cursor` / `conflict_record` 表
- 所有 core mutation 在事务内追加 `sync_changes` 行
- 即使没有 server，本地也开始累积变更流；server 上线后（Phase 3）一次性回放
- forward migration `0004_skybridge_tables.sql` 走 P3.2-a runner

## 范围

### In — Phase 2 要做

| 块 | 内容 |
|---|---|
| schema v4 | 三张新表 + 一个 forward migration 文件；`LATEST_KNOWN_VERSION = 4` |
| sync_changes 写入 | 在所有 core mutation 中事务内 INSERT 一行（或多行）`sync_changes` |
| 单测 | 每个 mutation 路径 + atomicity 回滚 + migration runner v3→v4 |

### Out — 留给 Phase 3+

- 真正读 `sync_cursor` 的逻辑（Phase 3 的 sync engine）
- `conflict_record` 的写入（Phase 5 的冲突 UI）
- HTTP client / SSE / 远端 server
- payload 形态最终化（Phase 3 server 接入时再 lock；Phase 2 用「能在空库 apply 重建」原则但不死磕）

### 明确不入 sync_changes

| 路径 | 原因 |
|---|---|
| `ensureSpecialNotes` / `ensureDeviceId` | 启动 bootstrap，不是用户变更；多设备靠固定 UUID 自然去重 |
| migration runner | schema 升级，不是数据变更（与 Phase 1 plan 一致） |
| **`saveConfig` / `PATCH /config`** | `owl_config.toml` 跨仓策略明确为"本地偏好，不跨设备同步"（见 `orpheus-aviary/.claude/CLAUDE.md` skybridge 同步范围表）；且 TOML 文件无法与 SQLite 事务原子绑定 |
| `reminder_status` 全部 mutation（`syncReminders` / `markFired` / `rescheduleRecurringReminder` / `cleanupOldFiredReminders` / `recomputeTrashDeadlines`） | 派生 + 本地状态：`/alarm` 标签是源真相，跟着 note 同步；fired/pending 是设备本地通知调度，跨设备无意义 |
| FTS 维护（`updateFtsTagsText`） | 派生索引 |
| `cleanupExpiredTrash` 自动清理 | 派生于 `auto_delete_at` 超时；多设备各自清理即可，不需要广播 |

> **`cleanupExpiredTrash` 决策**：当前实现（`packages/core/src/reminders/index.ts:303`）是 drizzle SELECT 出过期行的 ids，再 drizzle 逐条 `db.delete(notes).where(eq(notes.id, row.id)).run()`。语义上是"自动批量 permanentDelete"。
>
> 选择 **不发** sync_changes：每台设备各自基于本地 `auto_delete_at` 清理；server 端最终也基于 `auto_delete_at` 清理（Phase 3 server 实现时确认）。冗余删除事件没价值。
>
> 守卫脚本仅扫 `packages/daemon/src`，core 内部的 drizzle delete 不受影响。daemon scheduler 调 `cleanupExpiredTrash`（core 函数），不是 daemon 直写 → grep 守卫保持 0 violations。

> **scope 边界澄清**：父框架文档说"所有 core mutation 在事务内追加 sync_changes 条目"，但实际意思是"所有跨设备同步范围内的 core mutation"。`saveConfig` 是 core 的 mutation 但不在同步范围 — Phase 2 不修改 `saveConfig`，它继续按原样写 TOML 文件。

## schema v4

`packages/core/src/db/migrations/0004_skybridge_tables.sql`：

```sql
-- 0004_skybridge_tables.sql — sync_changes / sync_cursor / conflict_record
--
-- INVARIANT: Once shipped, this file is IMMUTABLE. Forward changes go into
-- 0005_*.sql, ... never edit.
--
-- Phase 2 only populates `sync_changes`. `sync_cursor` and `conflict_record`
-- are scaffolded so Phase 3 (sync engine) and Phase 5 (conflict UI) don't
-- need a second migration. Both stay empty until those phases land.

CREATE TABLE sync_changes (
  local_seq    INTEGER PRIMARY KEY AUTOINCREMENT,  -- strict monotonic, never reused
  device_id    TEXT NOT NULL,                       -- origin device UUID (from local_metadata.device_uuid)
  entity_type  TEXT NOT NULL,                       -- 'note' | 'folder' | 'conversation' (Phase 2 set)
  entity_id    TEXT NOT NULL,                       -- id in business table; '' if global (e.g. could-be-future ops)
  op           TEXT NOT NULL,                       -- see Op table below
  payload      TEXT NOT NULL,                       -- JSON; shape depends on (entity_type, op)
  created_at   INTEGER NOT NULL                     -- Unix ms
);

CREATE INDEX idx_sync_changes_created ON sync_changes(created_at);

-- Phase 3 placeholder. Empty in Phase 2; sync engine will read/write.
CREATE TABLE sync_cursor (
  endpoint    TEXT PRIMARY KEY,        -- server URL or logical id
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
```

`packages/core/src/db/migrate.ts` 把 `LATEST_KNOWN_VERSION` 从 `3` 改为 `4`。

**不**加 drizzle schema 定义（`syncChanges` / `syncCursor` / `conflictRecord`）：Phase 2 只通过 raw sqlite 写 `sync_changes`（见下文 emitSyncChange 设计），`sync_cursor` / `conflict_record` 在 Phase 2 全程不写。Phase 3 sync engine 想用 drizzle 时再加，零代价。

`migrate.test.ts` 加一个 v3→v4 回归测试（参考 P3.4-a 的 0002→0003 测试模板）。

## entity / op 命名空间

| entity_type | op | 触发函数 | payload 字段 |
|---|---|---|---|
| `note` | `create` | `createNote` | `content`, `folder_id`, `trash_level`, `created_at_ms`, `updated_at_ms`, `tags: [{tag_type, tag_value}]` |
| `note` | `update` | `updateNote` | sparse post-state — 只包含本次实际改动的列：`content?`, `folder_id?`, `tags?`, `updated_at_ms`（每次都带） |
| `note` | `trash` | `deleteNote`, `batchDeleteNotes` | `trash_level`, `trashed_at_ms`, `auto_delete_at_ms`, `updated_at_ms` |
| `note` | `restore` | `restoreNote`, `batchRestoreNotes` | `trash_level`, `trashed_at_ms`, `auto_delete_at_ms`, `updated_at_ms` |
| `note` | `delete` | `permanentDeleteNote`, `batchPermanentDeleteNotes` | `{}` |
| `note` | `pin` | `setNotePinned` | `pinned_at_ms` (number 或 null) |
| `note` | `update` | `reorderNotesInFolder` | 每个被改 note 单独发一行：`{ position }` |
| `folder` | `create` | `createFolder` | `name`, `parent_id`, `position`, `created_at_ms`, `updated_at_ms` |
| `folder` | `update` | `updateFolder` | sparse post-state（`name?`, `parent_id?`, `position?`, `updated_at_ms`） |
| `folder` | `update` | `deleteFolder`（reparent 子 folder） | 每个被 reparent 的 child 一行：`{ parent_id, updated_at_ms }` |
| `folder` | `delete` | `deleteFolder` | `{}`（自身 delete；子 folder 的 update 已经分别 emit） |
| `folder` | `update` | `reorderFolders` | 每个被改 folder 单独发：`{ parent_id, position, updated_at_ms }` |
| `conversation` | `append` | `appendConversationMessages` | `messages: [{role, content, tool_calls, tool_call_id, is_error, reasoning_content, reasoning_signature}]`, `applied_at_ms`；首次 emit 额外带 `title`, `created_at_ms` |
| `conversation` | `delete` | `deleteConversation` | `{}` |

> **payload 时间字段统一用 `_ms` 后缀**（Unix 毫秒）以避免 ISO string vs epoch 混乱。
>
> **payload sparse vs full snapshot**：update 类操作走 sparse（只包含本次 mutation 实际写入的列），delete/trash/restore 类走 fixed-shape，create 类走 full。Phase 3 server 看到 payload 后能 apply 即可。
>
> **payload 不含 `device_id` / `content_hash`**：
> - `device_id`：每行 `sync_changes` 自带 `device_id` 字段（origin 设备）。Phase 3 server 在 apply 时把对应 origin 写入业务表 `notes.device_id` / `folders.device_id`。payload 不再重复。
> - `content_hash`：从 `content` 派生（`createNote` / `updateNote` 内部用 `contentHash(content)` 算）。Phase 3 server 在 apply 时同样调 `contentHash` 重算，不需要载荷里带。
> - `updateNote` 实际写入的"额外"列（`content_hash`、`device_id`、`updated_at`）在 payload 里只保留 `updated_at_ms`，其余两列由 server 派生。
>
> **`createNote` payload 为何不含 `pinned_at_ms` / `position`**：`notes.pinned_at` 和 `notes.position` 在 schema 里都是 nullable，且 `createNote` 永远以 NULL 起始 — 必须用户后续 `setNotePinned` / `reorderNotesInFolder` 才能赋值。Server 回放 `note/create` 时这两列默认 NULL，等价正确；后续 `pin` op 和 `reorderNotesInFolder` 触发的 `update` op 各自携带新值。所以 create payload 省略它们既正确又最小。
>
> **`conversation/append` 时间字段语义**：`applied_at_ms` 即 `appendConversationMessages(sqlite, id, rows, now)` 的 `now` 参数。Phase 3 server apply 时：
> - 每条消息的 `ai_messages.created_at` = `applied_at_ms`
> - `ai_conversations.updated_at` = `applied_at_ms`
> - 首次 emit 时 `ai_conversations.created_at` = `created_at_ms` (= 该次的 `applied_at_ms`)，`title` 直接用 payload 字段
>
> 不依赖 `sync_changes.created_at` 推断，避免 Phase 3 server 时序歧义。
>
> **`deleteFolder` 算法（事务内顺序）**：
> ```
> 1. SELECT id FROM folders WHERE parent_id = <target> → children[]
> 2. UPDATE folders SET parent_id = <grandparent>, updated_at = now WHERE parent_id = <target>
> 3. for each childId in children: emit { entity:'folder', id:childId, op:'update', payload:{parent_id:<grandparent>, updated_at_ms:now} }
> 4. DELETE FROM folders WHERE id = <target>
> 5. emit { entity:'folder', id:<target>, op:'delete', payload:{} }
> ```
> 关键：先 SELECT 再 UPDATE，否则 UPDATE 后 children 已经不在 `parent_id=<target>` 上，无法回找。

## 实现路径

### 新增 `packages/core/src/sync/changes.ts`

```ts
import type Database from 'better-sqlite3';

export type SyncEntityType = 'note' | 'folder' | 'conversation';
export type SyncOp = 'create' | 'update' | 'trash' | 'restore' | 'delete' | 'pin' | 'append';

interface EmitArgs {
  entityType: SyncEntityType;
  entityId: string;
  op: SyncOp;
  payload: Record<string, unknown>;
}

/**
 * Append a sync_changes row in the current transaction. Uses raw sqlite
 * (not drizzle) so callers from any module can use it without coupling to
 * the drizzle schema.
 *
 * Reads device_id from local_metadata; if absent (e.g. core unit tests
 * that just opened :memory: without calling ensureDeviceId), inserts a
 * fresh UUID into local_metadata.device_uuid as a safety net. Production
 * daemon always calls ensureDeviceId at boot so this fallback never fires
 * there — it exists only to keep core mutation tests self-contained.
 *
 * Caller responsibility: only call inside an outer `sqlite.transaction(...)`
 * scope; the row must roll back together with the business table mutation.
 */
export function emitSyncChange(sqlite: Database.Database, args: EmitArgs): void { ... }
```

> **签名选 sqlite 而非 db**：conversation 模块只持有 sqlite，notes/folders 改造后也都会有 sqlite（见下文签名变更）；用 raw INSERT 避免把 sync_changes 加进 drizzle schema（Phase 3 sync engine 想用 drizzle 时再加，零代价）。
>
> **device_id 回退策略**：core 模块大量单测仅 `createDatabase(':memory:')`，并不会调 `ensureDeviceId`。如果 emit 时 `local_metadata.device_uuid` 为空又遇 `sync_changes.device_id NOT NULL` 约束直接炸，所有测试都得改。所以 `emitSyncChange` 在第一次发现缺 device_uuid 时 raw `INSERT INTO local_metadata` 自插一个 UUID。daemon 启动路径不变 —— 它继续在 boot 阶段调 `ensureDeviceId`，永远比 emit 路径先到，回退分支永远不会触发。**单一职责轻微妥协换零测试改造**。

### core mutation 签名变更（追加 sqlite 参数）

为保证每个 mutation 都能 `sqlite.transaction(...)` 包裹 + 调 `emitSyncChange(sqlite, ...)`，下列函数追加 `sqlite: Database.Database` 参数：

| 函数 | 当前签名 | Phase 2 签名 |
|---|---|---|
| `createFolder` | `(db, input)` | `(db, sqlite, input)` |
| `updateFolder` | `(db, id, input)` | `(db, sqlite, id, input)` |
| `deleteFolder` | `(db, id)` | `(db, sqlite, id)` |
| `permanentDeleteNote` | `(db, id)` | `(db, sqlite, id)` |
| `batchPermanentDeleteNotes` | `(db, ids)` | `(db, sqlite, ids)` |
| `setNotePinned` | `(db, id, pinned)` | `(db, sqlite, id, pinned)` |

调用点更新：
- `packages/daemon/src/routes/folders.ts`：`createFolder` / `updateFolder` / `deleteFolder` 调用点（`ctx.sqlite` 已在 context）
- `packages/daemon/src/routes/notes.ts`：`permanentDeleteNote` / `batchPermanentDeleteNotes` / `setNotePinned` 调用点
- core 内部各模块的单测同步更新
- **CLI `--direct` 不变**：`apps/cli/src/backend/direct.ts` 只暴露 notes CRUD，没用到这 6 个函数

`reorderNotesInFolder` / `reorderFolders` / `createNote` / `updateNote` / `deleteNote` / `restoreNote` / `batchDeleteNotes` / `batchRestoreNotes` / `appendConversationMessages` / `deleteConversation` 已经接收 sqlite，签名不变。

### 改造 core mutation（事务包裹策略）

| 函数 | 当前事务状态 | Phase 2 改动 |
|---|---|---|
| `createNote` | 未包（顺序 INSERT + syncNoteTags + SELECT） | 整体包进 `sqlite.transaction`，结尾 emit `note/create` |
| `updateNote` | 已 `sqlite.transaction` | 在事务尾追加 emit `note/update` |
| `deleteNote` | 已 `sqlite.transaction` | 在事务尾追加 emit `note/trash` |
| `restoreNote` | 已 `sqlite.transaction` | 在事务尾追加 emit `note/restore` |
| `permanentDeleteNote` | 未包（单条 drizzle delete） | 包 `sqlite.transaction`：DELETE + emit `note/delete` |
| `setNotePinned` | 未包（单条 drizzle update） | 包 `sqlite.transaction`：UPDATE + emit `note/pin` |
| `reorderNotesInFolder` | 已 `sqlite.transaction`（驱动 N 个 UPDATE） | 在事务内 N 个 UPDATE 之后 emit N 行 `note/update`（每行 `{ position }`） |
| `batchDeleteNotes` / `batchRestoreNotes` | 不是事务（循环调 deleteNote / restoreNote，每个内部各自事务） | 不动；emit 由内层函数已经发了 |
| `batchPermanentDeleteNotes` | 不是事务（循环调 permanentDeleteNote） | 同上不动；emit 由内层 `permanentDeleteNote` 发 |
| `createFolder` | 未包 | 包 `sqlite.transaction`：sibling SELECT + INSERT + emit `folder/create` |
| `updateFolder` | 未包 | 包 `sqlite.transaction`：cycle check + UPDATE + emit `folder/update` |
| `deleteFolder` | 未包 | 包 `sqlite.transaction`：按上文 5 步算法（SELECT children → UPDATE children → emit child updates → DELETE folder → emit folder delete） |
| `reorderFolders` | 已 `sqlite.transaction` | 事务内每个 stmt.run 之后 emit `folder/update` |
| `appendConversationMessages` | 已 `sqlite.transaction` | 事务尾追加 emit `conversation/append` |
| `deleteConversation` | 未包（单条 raw delete） | 包 `sqlite.transaction`：DELETE + emit `conversation/delete` |

> 包 transaction 的副作用：CAS（VersionMismatchError）和验证错误抛出后，transaction 自动回滚 — 业务行不写、sync_changes 行也不写。✓
>
> **batch 函数选择**：`batchDeleteNotes` / `batchRestoreNotes` / `batchPermanentDeleteNotes` 不再额外包外层 transaction —— 单 batch 失败到一半时，前面成功的 N-1 个仍然各自事务提交（含各自 sync_changes）。这与现状语义一致（"best effort，已成功的不回滚"）。如果 Phase 3 发现需要 batch 原子性，再增配。

### 单测策略（每个 mutation 一个最小用例）

放在各模块自己的 `index.test.ts` 里：

```ts
it('createNote emits a sync_changes row', () => {
  const note = createNote(db, sqlite, { content: 'x', deviceId: 'dev-1' });
  const row = readLatestSyncChange(sqlite);
  assert.equal(row.entity_type, 'note');
  assert.equal(row.entity_id, note.id);
  assert.equal(row.op, 'create');
  assert.equal(row.device_id, 'dev-1' /* or whatever ensureDeviceId returns */);
  const payload = JSON.parse(row.payload);
  assert.equal(payload.content, 'x');
});
```

每个 mutation 至少 1 个用例。Atomicity 用例：触发 CAS 失败，断言 sync_changes 也没多出行。

新增辅助：
- `packages/core/src/sync/changes.test.ts` — `emitSyncChange` 自身单测 + 端到端 helper
- 各模块 test 文件里加 `it('emits sync_changes row', ...)` 用例

预估 +20~25 测试用例。

### grep 守卫脚本更新

Phase 2 之后，core 内部 `packages/core/src/sync/changes.ts` 会出现 `INSERT INTO sync_changes` 字面量 —— 但守卫脚本只扫 `packages/daemon/src`，core 自由。✓

但为了避免误用：在 design doc 的 Implementation record 段落记录约定 "Phase 2 后 daemon 仍然不直接写 sync_changes，必须通过 core mutation 间接产生"。

## 测试矩阵（Phase 2 出口）

- [ ] `pnpm -w typecheck` 通过
- [ ] `just check` 通过
- [ ] 全量测试通过（baseline 576 + Phase 2 新增 ≈ 600）
- [ ] migration v3→v4 回归测试通过
- [ ] 每个 core mutation 验证发 sync_changes 行 + 内容
- [ ] CAS 失败 / 验证失败时 sync_changes **不写**（atomicity）
- [ ] 手动测试：典型 CRUD 流程后 `SELECT * FROM sync_changes` 行数 + payload 看着合理

## 开放问题（Phase 3 开工前要 settle）

1. payload 时间用 `_ms` 后缀 vs ISO 字符串 — 当前选 `_ms`
2. 单条 `appendConversationMessages` 一次发一行 vs 每条消息一行 — 当前选**一行**（batch），Phase 3 server 实现时如有问题再细化
3. `local_seq` 是否暴露给 GUI（debug 面板看 pending changes）— Phase 2 不暴露，Phase 3 设计 sync 状态栏时一起做
4. 如果 daemon 在事务中崩溃（机器断电），better-sqlite3 默认 WAL 已经保证原子性 — `sync_changes` 和业务表要么都在要么都不在 ✓
5. batch 函数（`batchDeleteNotes` 等）"内层各自事务、外层不包" 还是"外层一个大事务" — Phase 2 选**前者**（与现有"best effort，部分成功"语义一致）；Phase 3 server replay 时遇到部分成功的 batch 不会有问题（sync_changes 是按 local_seq 顺序回放，每行独立）

## 非目标

- 不实现 sync engine
- 不动 daemon HTTP 对外行为（仅 6 个 route handler 内的 core 调用站点 append `ctx.sqlite` 参数，对外 API 形态不变）
- 不动 GUI、CLI 任何对外行为
- 不写 server
- 不做端到端加密
- 不做去重 / 压缩 / GC（sync_changes 表无限增长在 Phase 2 里 OK；Phase 3 的 push 成功后才能 GC）

## Implementation record

**2026-05-08 — Phase 2 落地完成（待手动测试 + commit）**

代码改动：
- 新增 `packages/core/src/db/migrations/0004_skybridge_tables.sql`（sync_changes / sync_cursor / conflict_record）
- 修改 `packages/core/src/db/migrate.ts`：`LATEST_KNOWN_VERSION` 3 → 4
- 修改 `packages/core/src/db/migrate.test.ts`：F1 / F4 加 sync_changes 表存在断言（覆盖 v→v4 forward path）
- 新增 `packages/core/src/sync/changes.ts`：`emitSyncChange` + device_id auto-bootstrap
- 新增 `packages/core/src/sync/changes.test.ts`：6 用例（基础 / device_id 回退 / 事务回滚）
- 新增 `packages/core/src/sync/emission.test.ts`：18 用例（每个 mutation 路径 + atomicity）
- 修改 `packages/core/src/index.ts`：导出 sync 模块类型 + 函数
- 修改 `packages/core/src/notes/index.ts`：6 个 mutation 改造（createNote 包事务，updateNote/deleteNote/restoreNote 加 emit，permanentDeleteNote/setNotePinned 加 sqlite 参数 + 事务，batchPermanentDeleteNotes 加 sqlite 参数，reorderNotesInFolder 事务内 N 个 emit）
- 修改 `packages/core/src/folders/index.ts`：4 个 mutation 改造（createFolder/updateFolder/deleteFolder 加 sqlite 参数 + 事务 + emit；reorderFolders 事务内 N 个 emit；deleteFolder 用 SELECT-before-UPDATE 5 步算法）
- 修改 `packages/core/src/conversations/index.ts`：appendConversationMessages 事务尾 emit；deleteConversation 包事务 + emit
- 修改 daemon 调用点（`packages/daemon/src/routes/folders.ts` × 3、`packages/daemon/src/routes/notes.ts` × 3）：append `ctx.sqlite` 到 6 个 mutation 调用站点
- 测试用例签名同步更新（sed 批量改）

测试结果（**600/600 通过**）：
- core: 163 → **187**（+24：6 sync changes 自身 + 18 emission）
- cli: 119（不变）
- daemon: 138（不变）
- gui: 156（不变）

不变量验证：
- `pnpm -w typecheck` 通过
- `bash scripts/check-core-convergence.sh` → 0 violations（守卫脚本沿用 Phase 1）
- biome 在所有 13 个改过的文件上 0 错（pre-existing 在 NoteList.test.tsx / DraftReadyCard.tsx 沿用现状）

约定：**Phase 2 后 daemon 仍然不直接写 `sync_changes`，必须通过 core mutation 间接产生**。守卫脚本扫 daemon 源里 `db.{insert,update,delete}(schema.X)` / `INSERT INTO foo` / `UPDATE foo SET` / `DELETE FROM` 字面量，core 自由。

待办：
- [ ] 手动测试（按 owl `CLAUDE.md` 手动测试规范）
- [ ] commit + 准备 0.4.0 发版（Phase 3 前还要先 push 到 origin）
