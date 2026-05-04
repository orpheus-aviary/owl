# P3.4-a 设计：笔记排序模型（pinned_at + position）

> 日期：2026-05-05
> 状态：设计敲定（v2，code-review 修正后），待实施
> 前置：P3.3 0.3.0 已 ship（461/461 测试）
> 后置：P3.4-b ~ P3.4-f

## v2 修正记录（2026-05-05）

首轮草稿经 code-review 发现 4 个硬问题 + 3 个次要风险，本文档已相应修正：

| # | 问题 | 修正位置 |
|---|---|---|
| 1 | 新库初始化会漏掉 0002（`applyInitialSchema` stamp 到 LATEST 跳过 forward runner） | §3.1 —— 改为 stamp 1 后再调 `applyForwardMigrations(1, LATEST)` |
| 2 | "拖到 folder-node / root-blank 清空 position = NULL" 不等于落尾部（NULL 组按 updated_at DESC，而 move 会刷 updated_at → 反而排到 NULL 组最前） | §6.5 —— 改为"先 PATCH folder_id，再 reorder(尾部追加)" |
| 3 | "daemon 广播 note_updated / 走 bumpNotes" 前提不对（`OwlEvent` 只有 hello/open_note，`bumpNotes` 是 renderer data-bus） | §5.1 / §5.2 —— 改为前端 mutation 成功后本地 `bumpNotes()`，不新增 SSE 事件 |
| 4 | API 字段命名混用 snake_case 和 camelCase | §5.3 / §6.1 —— DTO 用 camelCase `pinnedAt` / `position`（和现有 `folderId` / `updatedAt` 对齐），SQL 列 `pinned_at` / `position`，query param `sort_by` / `pinned_first` |
| 5 | 索引 `(pinned_at, position, updated_at)` 不命中 FolderPanel 的 `WHERE trash_level + folder_id` 过滤 | §2 —— 改为 `idx_notes_folder_position (trash_level, folder_id, position, updated_at)` |
| 6 | `routes/notes.ts:45` 把非 `created` 的 `sort_by` 一律归 `updated`，加 `position` 语义会被静默吞掉 | §5.3 —— 明确扩展 query parser |
| 7 | `ForwardMigrationError` / `clearNotePosition` / `resolveMigrationFile` 等在现有代码里不存在 | §3.2 "新增 helpers / 类型" 清单显式列出 |

---

## 1. 范围

两件独立的事合并到一次 migration，避免 0002 + 0003 连环 ALTER：

| # | 功能 | 作用面 |
|---|---|---|
| 1 | 笔记同层级手动排序（`position`） | **仅 FolderPanel** 内展开文件夹看到的笔记行支持 DnD 重排 |
| 2 | 笔记置顶（`pinned_at`） | **编辑页 NoteList + 浏览页 BrowserPage** 生效置顶分组；**FolderPanel** 可右键切换属性 + 小图标指示，但不参与排序、不换底色 |

### 1.1 三处上下文行为矩阵

| 上下文 | 排序 | DnD 重排 | 右键置顶 | 置顶视觉 |
|---|---|---|---|---|
| **FolderPanel** 笔记行 | `position ASC NULLS LAST, updated_at DESC`（per-folder） | ✅ 同 folder / 未分类区内 + 跨 folder 拖到 note-gap | ✅ 改 `pinned_at` 属性 | 仅右侧 12px `Pin` 图标 |
| **编辑页 NoteList**（跨 folder flat 列表） | 置顶组 → 非置顶组，各自按 `updated_at DESC` | ❌ | ✅ | 背景区分 |
| **浏览页 BrowserPage** | 置顶组 → 非置顶组，各自按用户 sort（`updated/created × asc/desc`） | ❌ | ✅ | 背景区分 |

**范围外**（本阶段不做）：
- 回收站页 / 提醒页的 pin/sort
- 侧栏快捷按钮
- 跨组 DnD（因为只有 FolderPanel 支持 DnD，而 FolderPanel 不分组，所以无跨组问题）
- 方案 B→A 切换 position 物化策略（遇到问题再说）

---

## 2. Schema 改动（`0002_sorting.sql`）

```sql
-- 0002_sorting.sql — add pinned_at + position to notes
--
-- INVARIANT: Once shipped, this file is IMMUTABLE. Do not edit after v0.4.0.
-- PRAGMA user_version is NOT set here; the runner stamps it to 2.

ALTER TABLE notes ADD COLUMN pinned_at INTEGER;   -- NULL=未置顶；有值=置顶时间戳（ms）
ALTER TABLE notes ADD COLUMN position  REAL;      -- 同 folder 内排序 key（作用域 per folder_id）

-- FolderPanel 查询：WHERE trash_level=0 AND folder_id=? ORDER BY position, updated_at
CREATE INDEX idx_notes_folder_position
  ON notes(trash_level, folder_id, position, updated_at);
```

**非破坏性**：纯 ALTER TABLE ADD COLUMN，无数据回填。所有现有笔记 `pinned_at = NULL`、`position = NULL`，默认按 `updated_at DESC` 行为不变。

**不放 NOT NULL / DEFAULT**：
- `pinned_at NULL` = 未置顶（语义明确）
- `position NULL` = 未曾手动排序，排序时 `NULLS LAST`，不影响首次使用

**索引说明**：
- `idx_notes_folder_position` 当前**主要服务 `POST /notes/reorder` 的校验路径**（后端要按 folder_id 过滤拉 trash_level=0 的全部笔记检查 ordered_ids 完整性），以及未来可能新增的 per-folder `GET /notes?folder_id=...&sort_by=position` 查询
- FolderPanel 现在一次性拉全部笔记再前端 group（`fetchPanelNotes`），全表扫描按 `position, updated_at` 排序不走这个索引；本阶段不为此另做优化
- NoteList / BrowserPage 的 pin-first 分组表达式 `(pinned_at IS NULL)` 是表达式排序，SQLite 规划器在复合索引下走不了顺序扫描；本阶段不加表达式索引，等实测有性能问题再补部分索引 `CREATE INDEX ... WHERE pinned_at IS NOT NULL`
- drizzle schema.ts 字段命名：TS 侧 `pinnedAt` / `position`，SQL 列 `pinned_at` / `position`（与现有 `folderId → folder_id` 约定一致）

---

## 3. Forward migration runner 首验

P3.4-a 是 0.3.0 shipped 之后第一个前向 migration。`migrate.ts:1-37` 文件头列的 5 条 TODO 在此逐项兑现。

### 3.1 修正：新库初始化必须走 forward runner（避免漏 0002）

**问题**：当前 `applyInitialSchema()` 跑 0001 后直接 `stamp user_version = LATEST_KNOWN_VERSION`（migrate.ts:172-175）。如果 LATEST bump 到 2 但不改 applyInitialSchema，新建空库会得到 0001 schema 却被标成 v2 —— 缺 `pinned_at` / `position` 列，立即损坏。

**修正**：统一所有初始化路径，新库也走 forward runner。

```ts
// migrate.ts — 修改后
export function applyInitialSchema(sqlite: BetterSqlite3.Database): void {
  sqlite.exec(readInitialSql());
  sqlite.pragma('user_version = 1');                    // 旧行为改为固定 stamp 1
  applyForwardMigrations(sqlite, 1, LATEST_KNOWN_VERSION); // 再跑 0002+
}
```

调用方不变（index.ts:62 和 migrate.ts:388 rebuild 分支都继续调 `applyInitialSchema`，自动跑完所有 forward migration 到 LATEST）。

**副作用**：现有 `applyInitialSchema` 的单测如果断言 `user_version = LATEST_KNOWN_VERSION`，继续成立（forward runner 跑完后 user_version = LATEST）；如果断言"只跑了 0001.sql"的测试需要更新。

### 3.2 `applyForwardMigrations` 实现

替换 `migrate.ts:186` 的 stub。逻辑：

```ts
export function applyForwardMigrations(
  sqlite: BetterSqlite3.Database,
  fromV: number,
  toV: number,
): void {
  for (let v = fromV + 1; v <= toV; v++) {
    const file = resolveMigrationFile(v);        // e.g. 0002_sorting.sql — 新增 helper
    const sql = readFileSync(file, 'utf-8');
    assertNotDestructive(sql, v);                // header scan — 3.3
    sqlite.exec('BEGIN');
    try {
      sqlite.exec(sql);
      sqlite.pragma(`user_version = ${v}`);
      sqlite.exec('COMMIT');
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw new ForwardMigrationError(v, err);   // 新增 error class
    }
  }
}
```

**新增 helpers / 类型**（不是现有代码里能 grep 到的，需要本阶段实现）：
- `resolveMigrationFile(v: number): string` — `migrate.ts` 内部 helper，扫描 `migrations/` 找 `NNNN_*.sql`，v=2 → `0002_sorting.sql`
- `assertNotDestructive(sql: string, v: number): void` — 扫 SQL 文件第一行是否有 `-- requires_confirmation: true` 标记，命中则抛 `DestructiveForwardMigrationError`（见下）。0002 没这个标记所以直接通过
- `ForwardMigrationError extends Error` — SQL apply 失败时抛出，包含 `version` + `cause`
- `DestructiveForwardMigrationError extends Error` — 新增（不复用 `MigrationRequiredError`，后者构造器签名是 `(dbPath)`，语义绑定 legacy v0.2 rebuild 场景）。本错误签名 `(version, filePath)`，用于 forward migration 带 `requires_confirmation` 标记时；0002 不触发，仅测试 fixture 会触发，0.5.0+ 真实使用

对应 migrate.ts 文件头 5 条 TODO：
1. ✅ Per-file transaction（`BEGIN` / `COMMIT` / `ROLLBACK`）
2. ✅ user_version bookkeeping 在 runner，`.sql` 文件不 set
3. ⏭ Code migration（`NNNN_*.ts` 模块加载）—— 0002 不需要，留 TODO 不实现
4. ✅ Destructive marker（`-- requires_confirmation: true`）—— 0002 不带该标记
5. ⏭ Three-layer lock —— 仅破坏性 migration 需要，0002 跳过

### 3.3 `LATEST_KNOWN_VERSION` bump

`migrate.ts:54` 的 `LATEST_KNOWN_VERSION` 从 `1` 改为 `2`。

**兼容性**：
- 0.3.0 老用户升级到 0.4.0 首次启动 → `v == 1 < LATEST=2` → index.ts:68 走 `applyForwardMigrations(1, 2)` → stamp user_version = 2 → 正常启动
- 0.4.0 新装用户 → `v == 0 且空库` → `applyInitialSchema` 跑 0001 stamp 1 → 内部再 `applyForwardMigrations(1, 2)` stamp 2 → 正常启动
- 0.4.0 用户回滚到 0.3.0 → `v == 2 > LATEST=1` → `IncompatibleDbError` → 拒绝打开（符合 §5.5 决策）

### 3.4 新增测试

`migrate.test.ts` 新增：

- **新库路径**：`applyInitialSchema()` 后 `user_version = 2` 且 `pinned_at` 列存在（首要回归防线，对应 3.1 修正）
- **0.3.0→0.4.0 升级路径**：v=1 fixture 库上调 `applyForwardMigrations(1, 2)` → 列 + 索引存在、user_version = 2
- **Rebuild 分支**：mock 一个 v0.2 老库 → `migrateLegacyDb` → 结果库 user_version = 2（LATEST），证明 rebuild 路径也经过 forward runner
- 中途 SQL 错误 → ROLLBACK，user_version 保持 1，pinned_at 列不存在
- v = 2 上再跑 → no-op
- v = 3 fixture（未来版本）→ `IncompatibleDbError`
- 标 `-- requires_confirmation: true` 的 fixture migration → `DestructiveForwardMigrationError`

---

## 4. 排序规则（daemon 侧）

### 4.1 `listNotes` 参数扩展

`packages/core/src/notes/index.ts:listNotes` 现有参数：`trashLevel`、`folderId`、`includeDescendants`、`sortBy` (`updated|created`)、`sortOrder` (`asc|desc`)、`limit`、`offset`、查询/tags。

新增：

| 参数 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `pinnedFirst` | `bool` | `false` | `true` 时 `ORDER BY (pinned_at IS NULL) ASC, <existing>` |
| `sortBy` 扩展 | 新增 `'position'` | — | `ORDER BY position ASC NULLS LAST, updated_at DESC`（FolderPanel 用） |

### 4.2 三处 SQL 实际行为

```sql
-- FolderPanel（pinnedFirst=false, sortBy=position）
ORDER BY position ASC NULLS LAST, updated_at DESC

-- 编辑页 NoteList（pinnedFirst=true, sortBy=updated, sortOrder=desc）
ORDER BY (pinned_at IS NULL) ASC, updated_at DESC

-- BrowserPage（pinnedFirst=true, sortBy=user choice, sortOrder=user choice）
ORDER BY (pinned_at IS NULL) ASC, <updated_at|created_at> <ASC|DESC>
```

### 4.3 AI tools / 其他调用方

`packages/daemon/src/ai/system-prompt.ts`、`ai/tools/search-notes.ts`、`ai/tools/get-todos.ts`、`routes/todos.ts` 的 `listNotes` 调用**不改**，保持默认 `pinnedFirst=false`。AI 检索不关心 pin 状态。

---

## 5. daemon API 新增 / 修改

### 5.1 置顶切换

```
PATCH /notes/:id/pin
Body: { pinned: boolean }
Response: { success, data: Note }   // 返回完整 Note DTO（pinnedAt / position 字段都在内），前端直接替换 store 中的对应条目
```

- `pinned: true` → `pinned_at = Date.now()`
- `pinned: false` → `pinned_at = NULL`
- **不改 `updated_at`**（置顶是元数据，不是内容编辑）—— 不能复用 `updateNote`，需要新的 core helper `setNotePinned(db, id, pinned)` 直接 `UPDATE notes SET pinned_at = ? WHERE id = ?`
- **无 SSE 广播**：当前 `OwlEvent` 只有 `hello | open_note`（`events/types.ts:17`），不新增事件类型。前端 `PATCH /notes/:id/pin` 成功后自己调 `useDataBus.getState().bumpNotes()`，三个 list store 通过 data-bus subscription 自动 refetch（参考现有 note-store.ts:68-72）

### 5.2 同层级重排（方案 B：整组 reorder）

```
POST /notes/reorder
Body: { folder_id: string | null, ordered_ids: string[] }
Response: { success }
```

- `ordered_ids` 必须是目标 folder 内**全部**未 trash 笔记（`trash_level=0`）的完整 id 列表。后端校验：不多不少、全部属于该 folder。不符则 400。
- 后端事务内按顺序写 `position = 1000, 2000, 3000, ...`（整数起步，未来如需 fractional 再切 A 方案）
- `folder_id: null` 表示未分类区
- **不改 `updated_at`**（同 5.1 理由；新增 core helper `reorderNotesInFolder(db, sqlite, folderId, orderedIds)`）
- 前端同样在成功后本地 `bumpNotes()`

### 5.3 `GET /notes` 扩展参数 + 响应字段

**query 参数（`routes/notes.ts:33-46` 必须改）**：

| 参数 | 当前 | 改为 |
|---|---|---|
| `sort_by` | `query.sort_by === 'created' ? 'created' : 'updated'`（非 `created` 一律归 `updated`） | 扩展为 `'updated' \| 'created' \| 'position'`；非三者之一仍 fallback `updated` |
| `pinned_first` | 不存在 | 新增 `bool`，缺省 `false` |

core `listNotes` 签名扩展：`sortBy?: 'updated' | 'created' | 'position'`、`pinnedFirst?: boolean`。

**响应字段**：

Note DTO 增加 `pinnedAt: string | null`（ISO string，与 `createdAt` / `updatedAt` 一致）和 `position: number | null`。drizzle schema `pinnedAt` 用 `timestamp_ms` 模式，`position` 用 `real`。

**GUI 侧 `lib/api.ts` 对应同步**：
- `Note` interface 加 `pinnedAt: string | null`、`position: number | null`
- `listNotes` params 加 `sort_by?: 'updated' | 'created' | 'position'`、`pinned_first?: boolean`
- 新增 `pinNote(id, pinned)` 和 `reorderNotes(folderId, orderedIds)` 两个 wrapper

---

## 6. GUI 改动

### 6.1 `NoteListItem` 组件

新增 props：
- `pinned: boolean`（从 `note.pinnedAt != null` 推出 —— camelCase，与现有 `folderId` / `updatedAt` 惯例一致）
- `showPinBackground?: boolean`（默认 `true`；FolderPanel 用 `false`）

视觉：
- `showPinBackground && pinned` → 整行 `bg-accent/40`（占位，实际 token 确认用 `bg-primary/5` 还是 `bg-muted/40`，等实施时对比）
- `pinned` 无论 showPinBackground 值都在右侧显示 `Pin` (lucide) 12px 图标（优先级高于 active sort 时间戳）

### 6.2 `NoteList.tsx`（编辑页）

- `ContextMenu` 新增"置顶 / 取消置顶"菜单项（`Pin` / `PinOff` 图标），点击调 `PATCH /notes/:id/pin`
- 数据源：`note-store.ts` 的 `listNotes` 调用加 `pinned_first: true`（query param 是 snake_case，对应 core 的 `pinnedFirst` 字段由 daemon route parser 映射）
- 背景区分：通过 `NoteListItem` 默认 `showPinBackground=true`

### 6.3 `BrowserPage.tsx`

- 自定义 `handleContextMenu` state 菜单（已存在）新增"置顶 / 取消置顶"项
- `browser-store.ts` 的 `listNotes` 调用加 `pinned_first: true`
- `NoteListItem` `showPinBackground=true`

### 6.4 `FolderPanel.tsx`

- `FolderNoteRow` 的 `ContextMenu` 新增"置顶 / 取消置顶"
- `FolderNoteRow` 右侧加 `Pin` 图标（`pinned_at != null` 时渲染，否则占位 `div` 保持布局稳定）
- `showPinBackground=false`（或直接不用 `NoteListItem`，继续用自定义 row — 现状就是自定义 row，只加图标）
- `panelNotes` 取自 `GET /notes` with `sort_by=position`，前端按 `folder_id` group 后顺序保持不动

### 6.5 DnD 契约扩展（`lib/dnd-types.ts` + `MainApp.tsx`）

```ts
// 新增 DropTarget 变体
type DropTarget =
  | { kind: 'folder-node'; folderId: string }
  | { kind: 'folder-gap'; parentId: string | null; index: number }
  | { kind: 'root-blank' }
  | { kind: 'note-gap'; folderId: string | null; index: number };   // NEW
```

**FolderPanel 渲染**：
- `ChildrenBlock` 在渲染 `folderNotes.map(FolderNoteRow)` 前后和之间插入 `DroppableNoteGap`
- `UnfiledSection` 同样渲染
- `DroppableNoteGap` 用 VSCode 风格 2px 高蓝线 indicator（复用 `folder-gap` 的视觉）

**`handleNoteDrop` 扩展**（`MainApp.tsx:162`）：

```ts
async function handleNoteDrop(drag, drop) {
  if (drop.kind === 'folder-node') {
    // 移到该 folder 的尾部。
    // ⚠️ "position = NULL" 不等于尾部 —— NULL 组会按 updated_at DESC 排，
    //    而 moveNoteToFolder 走 updateNote 会刷新 updated_at，笔记反而跑到 NULL 组最前。
    // 正确做法：先 PATCH folder_id，再 reorder(ids=[当前目标 folder 全部 id, dragged 追加末尾])
    await moveNoteToFolder(drag.noteId, drop.folderId);
    await reorderToTail(drop.folderId, drag.noteId);   // helper: 见下
    return;
  }
  if (drop.kind === 'root-blank') {
    await moveNoteToFolder(drag.noteId, null);
    await reorderToTail(null, drag.noteId);
    return;
  }
  if (drop.kind === 'note-gap') {
    const srcFolderId = getNoteFolder(drag.noteId);
    if (srcFolderId !== drop.folderId) {
      await moveNoteToFolder(drag.noteId, drop.folderId);
    }
    // 前端重建目标 folder 的 ordered_ids 列表（含拖入笔记插到 drop.index）并调 reorder
    const reordered = buildReorderList(drop.folderId, drag.noteId, drop.index);
    await reorderNotes(drop.folderId, reordered);
    return;
  }
}

// 前端 helper：从 panelNotes 取目标 folder 的当前顺序，追加 dragged 到末尾，发 reorder
async function reorderToTail(folderId: string | null, draggedId: string) {
  const existing = getPanelNotesOrder(folderId).filter((id) => id !== draggedId);
  await reorderNotes(folderId, [...existing, draggedId]);
}
```

**跨 folder 拖到 note-gap**：
1. 先发 `PATCH /notes/:id { folder_id }`（已有 API）
2. 源 folder 的剩余笔记**不需要** reorder —— position 保留值，后续顺序自然紧凑。用户如介意间隙，下次手动拖一次即可。
3. 目标 folder 重排：前端从 `useNoteStore` / panelNotes 拿目标 folder 当前所有笔记 id（按当前 position 顺序），把新笔记插到 `drop.index` 位置，发 reorder。

**副作用约定**：`moveNoteToFolder` 会刷 `updated_at`（因为走 `updateNote`），这是现有行为，不改动。排序尾部语义由随后的 `reorderToTail` / `reorderNotes` 保证，而不是靠 position = NULL。

---

## 7. 数据兼容 / 初始状态

- 0.4.0 首次启动（新装用户）→ `applyInitialSchema` 跑 0001 stamp 1 → 内部调 `applyForwardMigrations(1, 2)` 跑 0002 stamp 2 → 所有笔记 `pinnedAt=null, position=null`
- 0.4.0 升级用户（原 v=1）→ `applyForwardMigrations(1, 2)` → 新列加好，现有笔记 `pinnedAt=null, position=null`
- 0.4.0 老用户（原 v0.2 rebuild 路径）→ `migrateLegacyDb` 内部 `applyInitialSchema` → 走上面的新装分支 → 同样落到 user_version = 2
- FolderPanel 首次打开 → 按 `position ASC NULLS LAST, updated_at DESC` 排 → 全 NULL → 等价于 `updated_at DESC`（与现状一致）
- 用户首次在 folder-x 里拖 note-A → 前端 reorder(ids=[folder-x 所有笔记按当前显示顺序，A 插入到 drop.index]) → 后端写 1000, 2000, 3000, ... → position 物化完成
- 未曾 DnD 的 folder 永远保持 NULL，行为不变

---

## 8. 测试计划

### 8.1 自动化

**core / `migrate.test.ts`**：
- `applyForwardMigrations` 1→2 成功、幂等、中途失败 ROLLBACK、未来版本抛 Incompatible

**core / `notes.test.ts`**（新增或扩展）：
- `listNotes` with `pinnedFirst=true` 置顶组在上
- `listNotes` with `sortBy='position'` 按 position ASC NULLS LAST 排
- 置顶 + sort 组合：置顶组内部仍按 sortBy 排序

**daemon / `server.test.ts`**（新增）：
- `PATCH /notes/:id/pin` 设置 / 清空 / pinned_at 不影响 updated_at
- `POST /notes/reorder` 成功写入 position 1000/2000/3000
- `POST /notes/reorder` 校验失败路径：ids 缺漏、ids 含其他 folder 的笔记、ids 含 trash 笔记 → 400
- 重排后 `GET /notes?sort_by=position` 顺序正确

### 8.2 手动测试（见 §10）

---

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 方案 B（整组 reorder）n 过大写入慢 | n 是单 folder 笔记数，实测 <500 可接受；超过再切 A 方案 fractional |
| 跨 folder 拖到 note-gap 后源 folder position 留空档 | 不影响排序（position 是有序 key 不是连续索引）；用户手动拖一次触发该 folder reorder 会自然紧凑 |
| 0002 apply 失败把用户数据锁死 | `applyForwardMigrations` 事务包裹 + 文件头 INVARIANT 注释禁止未来编辑；ALTER TABLE ADD COLUMN 在 SQLite 是 O(1)，风险极低 |
| `Pin` 图标和 P3.4-b 的 #随记/#待办 彩色边框叠加视觉乱 | 可接受（用户明确同意同时出现）；实施时直观检查，必要时把 Pin 图标放到笔记时间戳左边而非右边 |
| BrowserPage 下用户选 `created_asc` 时置顶组"最老的在上"体感怪 | 这是用户明确的"各自独立按现有规则"语义；不改。如果用户反馈再讨论 |

---

## 10. 手动测试清单（实施后填）

### 手动测试：FolderPanel DnD 重排

（待实施时补步骤）

### 手动测试：编辑页 NoteList 置顶

（待实施时补步骤）

### 手动测试：BrowserPage 置顶 + 用户 sort 切换

（待实施时补步骤）

### 手动测试：跨 folder 拖到 note-gap

（待实施时补步骤）

### 手动测试：0.3.0 → 0.4.0 升级

（待实施时补步骤，含真实库备份）

---

## 11. 实施顺序建议

1. **Schema + migration runner**（core）
   - `0002_sorting.sql`（注意索引是 `idx_notes_folder_position`）
   - 新增 `resolveMigrationFile` / `assertNotDestructive` helpers + `ForwardMigrationError` 类
   - `migrate.ts:applyForwardMigrations` 实装（事务包裹 + 逐版本 stamp）
   - `migrate.ts:applyInitialSchema` 改为 stamp 1 后内部调 `applyForwardMigrations(1, LATEST)`
   - `LATEST_KNOWN_VERSION = 2`
   - `schema.ts` 加 `pinnedAt`（`timestamp_ms`）/ `position`（`real`）字段
   - §8.1 migrate 全部测试绿（含新库路径 + 升级路径 + rebuild 路径）
2. **core listNotes**：加 `pinnedFirst`、`sortBy='position'`；§8.1 notes 部分绿
3. **core helpers**：新增 `setNotePinned` / `reorderNotesInFolder`（都不刷 updated_at）
4. **daemon API**：
   - `routes/notes.ts` query parser 扩展 `sort_by` / `pinned_first`
   - 新增 `PATCH /notes/:id/pin` + `POST /notes/reorder`
   - §8.1 server 部分绿
5. **GUI lib/api.ts**：`Note` interface 加 `pinnedAt` / `position`；`listNotes` params 加 `sort_by='position'` / `pinned_first`；新增 `pinNote` / `reorderNotes` wrapper
6. **GUI stores**：`note-store` + `browser-store` 调用加 `pinned_first: true`；`folder-store` 的 panelNotes fetch 改 `sort_by=position`
7. **GUI UI - 置顶**：三处右键菜单 + `NoteListItem` 背景 + `Pin` 图标；FolderPanel 右键 + 图标（mutation 后本地 `bumpNotes()`）
8. **GUI UI - DnD**：`DropTarget.note-gap` + `FolderPanel` gap droppable + `MainApp.handleNoteDrop` 扩展（含 `reorderToTail` 修正）
9. **手动测试** §10 五项逐一签字
10. **提交** — 单一 PR，P3.4-a 完成 → 更新 PROCESS.md

每步 `just check` + 相关测试段绿才进下一步。

---

## Implementation record

**Shipped 2026-05-05**。实施顺序按 §11 的 8 步，每步 `just check` + 相关测试绿后才进下一步。最终测试：**core 150/150（+14 新）**、**daemon 128/128（+6 新）**、**gui 92/92（修 2 处 `LATEST_KNOWN_VERSION` 硬编码）**、lint + typecheck 全绿。

### 改动面

| # | 范围 | 文件 |
|---|---|---|
| 1 | Migration | `0002_sorting.sql`（新增）；`migrate.ts`（`LATEST=2`、`applyInitialSchema` 改为 stamp 1 后跑 forward runner、实装 `applyForwardMigrations` 事务包裹、新增 `resolveMigrationFile` / `assertNotDestructive` / `ForwardMigrationError` / `DestructiveForwardMigrationError`）；`schema.ts`（`pinnedAt` / `position` 字段）；`index.ts` re-exports；`migrate.test.ts`（F1-F8 共 8 个测试） |
| 2 | core listNotes | `notes/index.ts`（`sortBy` 增加 `'position'`、新增 `pinnedFirst` 参数，`ORDER BY` 动态拼 group/main clause）；`notes/index.test.ts`（6 个 pin+position 排序测试） |
| 3 | core helpers | `notes/index.ts`（`setNotePinned` + `reorderNotesInFolder`，都不刷 updated_at）；`notes/index.test.ts`（7 个 helper 测试） |
| 4 | daemon API | `routes/notes.ts`（`sort_by` 扩展 + `pinned_first` 参数 + `PATCH /notes/:id/pin` + `POST /notes/reorder`）；`server.test.ts`（6 个 P3.4-a 测试） |
| 5 | GUI api.ts | `lib/api.ts`（`Note.pinnedAt` / `position` 字段、`listNotes` 参数扩展、`pinNote` / `reorderNotes` wrapper）；`NoteAppliedToast.tsx` + `editor-store.test.ts` 补 Note literal 字段 |
| 6 | GUI stores | `note-store.ts` / `browser-store.ts` 加 `pinned_first:true`；`folder-store.ts` panelNotes 改 `sort_by=position` |
| 7 | GUI UI 置顶 | `NoteListItem.tsx`（`pinned` + `showPinBackground` props、Pin 图标 + `bg-primary/5` 背景）；`NoteList.tsx` / `BrowserPage.tsx` / `FolderPanel.tsx` 三处右键菜单；FolderPanel 的 `FolderNoteRow` 加 Pin 图标无背景 |
| 8 | GUI DnD | `dnd-types.ts`（`note-gap` DropTarget）；`FolderPanel.tsx`（`DroppableNoteGap` 组件 + `ChildrenBlock` / `UnfiledSection` 插入 gap）；`MainApp.tsx`（`buildReorderList` helper + `handleNoteDrop` 三分支：folder-node / root-blank 落尾部改 reorder、note-gap 插入 + 跨 folder 首先 PATCH folder_id） |
| 9 | GUI test fixes | `migration-ipc.test.ts` / `migration-precheck.test.ts` 改用 `LATEST_KNOWN_VERSION` 取代硬编码 v1 |

### v2 设计 code-review 修正点在实施中全部落地

1. ✅ 新库初始化不漏 0002：`applyInitialSchema` 跑 0001 + stamp 1 + 内部 `applyForwardMigrations(1, LATEST)`；F1 测试作为 guard
2. ✅ "拖到 folder-node 落尾部"不再靠 position=NULL（会被 updated_at 推到顶），改为 move 后显式 reorder 追加到末尾
3. ✅ 前端 mutation 成功后本地 `useDataBus.getState().bumpNotes()`，不新增 SSE 事件
4. ✅ DTO 统一 camelCase `pinnedAt`，query param 统一 snake_case `pinned_first` / `sort_by=position`
5. ✅ 索引 `idx_notes_folder_position (trash_level, folder_id, position, updated_at)` 服务 reorder 校验路径
6. ✅ `routes/notes.ts` query parser 显式扩展，`sort_by=position` 不再被静默吞为 `updated`
7. ✅ 所有新增 helpers / 错误类型（`ForwardMigrationError` / `DestructiveForwardMigrationError` / `resolveMigrationFile` / `assertNotDestructive` / `setNotePinned` / `reorderNotesInFolder` / `pinNote` / `reorderNotes` / `buildReorderList`）全部实装

### 手动测试记录

2026-05-05 用户本机（macOS arm64，真实 owl.db v=1）手动验证：

| # | 测试项 | 结果 |
|---|---|---|
| 0 | v=1 → v=2 自动升级，`pinned_at` / `position` 列到位，`#真实` 笔记全部保留 | ✅ |
| 1 | FolderPanel 同 folder DnD 重排 + 刷新后持久化 | ✅ |
| 2 | 未分类区 DnD 重排 + 持久化 | ✅ |
| 3 | 跨 folder 拖 note-gap（未分类 → 测试 folder 两条之间）| ✅ |
| 4 | 编辑页 NoteList 右键置顶 + 背景 + 📌 图标 + 跳顶 | ✅ |
| 5 | BrowserPage 置顶 + sort 切换下置顶仍在上 | ✅ |
| 6 | FolderPanel 右键置顶（仅属性 + 图标，无背景、不改 position 排序）| ✅ |
| 7 | 置顶后 DnD：position 变，pin 状态不受影响，编辑页仍在置顶组 | ✅ |

升级前备份：`~/orpheus-aviary-nest/owl/owl.db.pre-p3-4-a-1777927094`，可留作回滚点或手动删除。

### 后续 / 留下的 follow-up

- 0.4.0 发版后可观察：position 在极端情况下（超大 folder / 频繁 DnD）性能如何；如果 n 过大 reorder 写入慢，按 §9 风险表切换到方案 A（fractional indexing + 懒物化）
- `idx_notes_pinned_updated` 的表达式部分索引暂不加，等实测 pin-first 分组查询有性能问题再补
- 0.5.0 如果有破坏性 forward migration，用 `DestructiveForwardMigrationError` 路径（本阶段已预留 + 有 fixture 测试）
