# P4 Phase 1 — daemon 入口收敛 design

日期：2026-05-08
状态：草案，开工前需用户确认 scope
父框架：`docs/plans/2026-05-07-p4-skybridge-plan.md`
跨仓架构：`aviary/docs/SKYBRIDGE_ARCH.md`

## 目标

让 owl 内部所有"用户数据写入"路径都收敛到同一批 `@owl/core` 函数，作为 Phase 2 在事务内追加 `sync_changes` 的不变量基础。

> Phase 2 之所以能"事务内追加 change log"，靠的是"所有 mutation = core 函数"这个静态不变量。Phase 1 把这个不变量从经验观察变成代码层固化的规则。

## 调查结果（baseline，2026-05-08）

### 已经走 core（无需改动）

| 路径 | 端点 / 调用点 | 命中的 core 函数 |
|---|---|---|
| GUI / CLI(http) | `POST /notes` | `createNote` |
| GUI / CLI(http) | `PUT /notes/:id` `PATCH /notes/:id` | `updateNote` |
| GUI / CLI(http) | `DELETE /notes/:id` | `deleteNote` |
| GUI / CLI(http) | `POST /notes/:id/restore` | `restoreNote` |
| GUI / CLI(http) | `POST /notes/:id/permanent-delete` | `permanentDeleteNote` |
| GUI / CLI(http) | `POST /notes/batch-{delete,restore,permanent-delete}` | `batchDeleteNotes` / `batchRestoreNotes` / `batchPermanentDeleteNotes` |
| GUI / CLI(http) | `PATCH /notes/:id/pin` | `setNotePinned` |
| GUI / CLI(http) | `POST /notes/reorder` | `reorderNotesInFolder` |
| GUI / CLI(http) | `PATCH /notes/:id/move` | `updateNote` |
| GUI / CLI(http) | `PATCH /notes/:id/toggle-todo` | `updateNote` |
| GUI / CLI(http) | `POST /folders` `PUT /folders/:id` `DELETE /folders/:id` `PATCH /folders/reorder` | `createFolder` / `updateFolder` / `deleteFolder` / `reorderFolders` |
| GUI | `PATCH /config` | `saveConfig` |
| AI 工具 | `apply_update` / `append_memo` / `add_todo` / `create_reminder`（commit 后） | `createNote` / `updateNote` |
| 调度器 | trash 清理、过期 fired 清理、`recomputeTrashDeadlines`、`syncReminders`、`markFired` | core reminders 模块 |
| CLI `--direct` | `notes` CRUD（`apps/cli/src/backend/direct.ts`） | `coreCreateNote` / `coreUpdateNote` / `coreDeleteNote` / `coreRestoreNote` |

> CLI 没有 folder / tag mutation 命令（`apps/cli/src/commands/` 仅有 `tag/get/migrate/doctor/folders/append/skill-template/search/open/trash/edit/create/delete/skill`，folders 子命令是 list-only），所以 CLI `--direct` 当前覆盖面足够。

### 仍绕过 core（Phase 1 要修的两处）

**Gap 1：`ConversationStore`（P3.4-f 引入）**

文件：`packages/daemon/src/ai/conversations.ts`

直接对 `ai_conversations` / `ai_messages` 执行 SQL 的方法：

| 方法 | 行号 | 业务效果 |
|---|---|---|
| `appendMessages` | 122-144 | INSERT `ai_conversations`（首次）+ INSERT `ai_messages` × N + UPDATE `ai_conversations.updated_at` |
| `delete` | 193-197 | DELETE `ai_conversations`（带级联） |
| `ensureConversationRow` | 146-155 | INSERT `ai_conversations`（被 appendMessages 调用） |

`setSystemMessage` 是内存级，不写库，不在收敛范围。

**Gap 2：`ReminderScheduler.handleFrequency`**

文件：`packages/daemon/src/scheduler.ts:199-212`

```ts
this.db
  .insert(schema.reminderStatus)
  .values({ noteId, tagId, fireAt, status: 'pending', firedAt: null })
  .onConflictDoUpdate({ target: [...], set: {...} })
  .run();
```

重复提醒（`/daily` `/weekly` 等）触发后排下一次的写入。`syncReminders` / `markFired` 已经在 core，唯独这一段没有。

### 不在收敛范围内（明确豁免）

- **migration runner**（P3.2-a）：schema 升级动作，不是用户数据变更，不进 `sync_changes`
- **`PreviewStore`**：纯内存 stash，不落库
- **`scheduler` 内的 `db.select` / 周期定时器**：读路径或控制流，非 mutation
- **`POST /events/emit`**：SSE 广播，不写业务表

## Phase 1 改动方案

### Change 1 — 新建 `packages/core/src/conversations/`

把 `ConversationStore` 的写入语义拆为两层：

- **core**（新模块）：`appendConversationMessages` / `deleteConversation` / `ensureConversation` / `hydrateConversation` / `listConversationSummaries`，纯函数 + 直接 SQL（沿用现在 `better-sqlite3` 的写法），所有 INSERT/UPDATE/DELETE 都在这里
- **daemon**：`ConversationStore` 退化为内存缓存 + delegation。`getOrCreate` / `setSystemMessage` / `trimToRounds` / `get` 留在 daemon（内存语义）；`appendMessages` / `delete` / `list` 改为调用 core 后同步内存

模块边界跟现有 `core/src/notes/` `core/src/folders/` 一致。core export 加：

```ts
export {
  appendConversationMessages,
  deleteConversation,
  hydrateConversation,
  listConversationSummaries,
} from './conversations/index.js';
export type {
  ConversationRow,
  ConversationMessageRow,
  ConversationSummary,
} from './conversations/index.js';
```

测试：core 模块自带单元测试；daemon 端 `agent-loop.test.ts` / `ai.test.ts` 维持现状即可（因为对外 ConversationStore 的行为不变）。

### Change 2 — 把 `handleFrequency` 的写入抽到 core

新 core 函数（在 `packages/core/src/reminders/index.ts` 旁边或作为新方法）：

```ts
export function rescheduleRecurringReminder(
  db: OwlDatabase,
  noteId: string,
  tagId: string,
  nextFireAt: number,
): void
```

逻辑就是当前 `scheduler.ts:199-212` 那段 upsert。

`scheduler.ts` 改为：

```ts
import { rescheduleRecurringReminder } from '@owl/core';
// ...
rescheduleRecurringReminder(this.db, fired.noteId, fired.tagId, nextFireAt);
```

频率挑选（`FREQ_PRIORITY` + 排序）+ 下一次时间计算（`computeNextFireAt`）留在 daemon scheduler，因为那是调度策略而非数据库语义。

### Change 3 — 不变量回归测试

新文件：`packages/daemon/src/__tests__/core-convergence.test.ts`（或合适位置）。
方式：用 `mock` 拦截 `@owl/core` 的所有 mutation 函数，跑一组典型 HTTP 调用 + scheduler 触发，断言每个 mutation 都至少有一个对应的 core 调用。

但这种 mock 拦截测试维护成本高，更轻量的做法：
- **静态规则**：在 `packages/daemon/src/routes/*.ts` + `packages/daemon/src/scheduler.ts` + `packages/daemon/src/ai/conversations.ts` 顶部加注释说明 "**禁止**直接 `db.insert/update/delete` 业务表，所有 mutation 必须经 `@owl/core`"
- **lint 规则**：Biome 不直接支持自定义规则，但可以在 `just check` 里加一行 `grep` 守卫，扫描 daemon 源码里出现 `\.insert(schema\.` / `\.update(schema\.` / `\.delete(schema\.` / `sqlite\.prepare.*INSERT\|UPDATE\|DELETE` 的违规行（白名单豁免 conversations 模块改造后的状态、scheduler 不再有违规、SSE/PreviewStore 等不涉及业务表）

最终选定方案：**注释约定 + grep 守卫脚本**，不上 mock 拦截测试。脚本初版接受零违规作为不变量；以后 daemon 加新 mutation 必须先在 core 加函数。

具体实现：`packages/daemon/scripts/check-core-convergence.sh`，在 `just check` 里调用一次。Phase 2 schema v4 加表后，更新白名单允许 `sync_changes` 自身的写入。

### Change 4 — `PROCESS.md` + `CLAUDE.md` 收尾

- `PROCESS.md` 新增 P4 段落，标记 Phase 1 子任务清单
- 不在 owl 顶层 `CLAUDE.md` 加新规则（avoid CLAUDE.md 膨胀），但在 design doc 的 Implementation record 段落写明约定，未来违规由 grep 守卫拦截

## 不在 Phase 1 范围（明确）

- 不动 schema（v4 留给 Phase 2）
- 不引入 `sync_changes` 表
- 不动 GUI、CLI 命令的对外行为
- 不重写 `agent-loop.ts` 调用 `ConversationStore` 的 API（保持 `appendMessages` 等方法名）
- 不优化 `ConversationStore` 的内存语义
- 不动 `migration runner`

## 测试矩阵（Phase 1 出口）

- [ ] `pnpm -w typecheck`（`tsc --noEmit`）通过
- [ ] `pnpm -w test` 通过（baseline 563/563）
- [ ] core 新增 conversations 模块单测：`appendConversationMessages` 首次创建 / 追加 / `deleteConversation` 级联 / `hydrateConversation` 还原 reasoning 字段
- [ ] core 新增 `rescheduleRecurringReminder` 单测（与 `markFired` / `syncReminders` 同等粒度）
- [ ] grep 守卫脚本运行通过
- [ ] 手动测试：daemon 启动 → AI 聊天一轮 → 重启 daemon → 历史正常水合；创建 `/daily` 提醒 → 触发后下一次自动排（用 fake-time 或人工等）

## 开放问题

1. core conversations 模块用 raw `sqlite.prepare` 还是 drizzle？
   倾向 **raw sqlite**：当前 ConversationStore 已经是 raw（schema 字段名跟 `ai_messages` 表是 snake_case，drizzle schema 暂未覆盖 ai_* 表），改 drizzle 会扩散到 schema.ts。
2. `listConversationSummaries` 算 mutation 的对偶（read），要不要也搬到 core？
   倾向 **是**，跟写入放一起便于内聚；daemon 层 ConversationStore 直接 delegate。
3. `rescheduleRecurringReminder` 是否合并进 `markFired`？
   倾向 **不合并**：scheduler 还要做频率选择 + 时间计算，core 只接收"下一次时间"作为参数；语义边界清楚。

## Implementation record

**2026-05-08 — Phase 1 落地完成**

文件改动：
- 新增 `packages/core/src/conversations/index.ts` — raw sqlite 实现，5 个 export（4 函数 + 3 类型）
- 新增 `packages/core/src/conversations/index.test.ts` — 11 个 test cases（append × 6、delete × 2、hydrate × 2、list × 1）
- 修改 `packages/core/src/index.ts` — 导出 conversations 模块 + `rescheduleRecurringReminder`
- 修改 `packages/core/src/reminders/index.ts` — 新增 `rescheduleRecurringReminder` 函数
- 修改 `packages/core/src/reminders/index.test.ts` — 新增 2 个 reschedule test cases
- 修改 `packages/daemon/src/ai/conversations.ts` — `ConversationStore` 退化为内存缓存 + `LlmMessage` ↔ row 翻译，所有 DB 写入 delegate 到 core
- 修改 `packages/daemon/src/scheduler.ts` — `handleFrequency` 改用 `rescheduleRecurringReminder`，移除直接 drizzle upsert
- 新增 `scripts/check-core-convergence.sh` + `justfile` 接入 `just check`

测试结果：
- core: 150 → 163（+13）
- cli: 119（不变）
- daemon: 138（不变）
- gui: 156（不变）
- 总计：**576/576 通过**

不变量验证：
```
$ bash scripts/check-core-convergence.sh
core-convergence: 0 violations in packages/daemon/src
```

待办：
- [ ] 手动测试（按 owl `CLAUDE.md` 手动测试规范）
- [ ] commit + 进入 Phase 2

**预存在的 lint 错误**：`packages/gui/src/renderer/src/components/NoteList.test.tsx`（noNonNullAssertion）+ `DraftReadyCard.tsx`（cognitive complexity）— 来自 P3.4-e / P2-8，与 Phase 1 无关，沿用现状不修。
