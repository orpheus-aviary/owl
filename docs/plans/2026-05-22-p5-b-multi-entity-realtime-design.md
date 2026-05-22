# P5-b — 多 entity apply + tags/FTS + SSE 实时触发

> 2026-05-22 起草。v5 — v4 评审又发现 4 项需修（tag_type 假 enum / AppContext 漏字段 + scheduler 路径 / SyncStatus shape 与现有 endpoint 冲突 / 多处残留旧措辞），全部本版改完，"五个拍板点"在 §13 收口。承接 `docs/plans/2026-05-21-p5-a-skybridge-sync-engine-design.md`（已 ship 内部）。不发版；P5-b 完成时仍以 0.4.1 为公开发版，0.5.0 留给 P5-c 完工后。

## 1. 背景与目标

### 1.1 P5-a 留下了什么

P5-a `runSync()` 已经把 owl daemon 接到 `@skybridge/client`，单机双 profile 下 note 五个 content op（create/update/trash/restore/delete）双向收敛。但还有四块明显缺口让"看起来在用"和"真的能在多设备生活"之间隔着一道：

1. **B 设备拉到的 note 没有 tags** — `#`、`/alarm`、`@todo` 关系全丢；编辑器 TagBar 空，FTS 搜不到，reminder 不会响
2. **folder / conversation 整类 entity 不 apply** — A 端建文件夹、改聊天，B 端看不见
3. **同步必须人手触发** — owl CLI 跑 `sync run` 或者 daemon HTTP POST，没有 server 推过来"现在有新东西"的能力
4. **GUI 完全无感** — 没状态栏、没手动按钮、没 workspace/device 显示

### 1.2 P5-b 一句话

把 P5-a 的 note 单 entity / 手动触发链路扩成 **多 entity apply + SSE 触发 + GUI 状态栏**，并把验收从手动 8 步搬到自动化测试，从此 P5-c / P6 可以基于"看得见、能跨页面感知"的 sync 状态做。

### 1.3 必证四条

1. note tags / FTS / reminder 跨设备
2. folder / conversation apply LWW 正确
3. server 端发出 `event: change` 后 100ms 内 daemon 主动 pull、GUI 状态栏出现"正在同步"
4. 自动化测试覆盖 §8.3 D1-D12，CI 上可重复跑

### 1.4 不做

- 后台**定时**触发、网络恢复触发、429 / 5xx 重试策略 — 留 P5-c
- `conflict_record` 写入语义 + 冲突 UI — 留 P5-c / P6
- 真实双机 + 远程 server soak — 留 P5-c
- 多设备 GA、attachment 通道 — 留 P6
- keychain 替换明文 token — 留 P5-c

## 2. 范围（硬钉）

### In — P5-b 必做

- **B1 schema v6 加 `local_device_uuid`**
  - `notes` / `folders` 加 `local_device_uuid TEXT` 列（**ADD COLUMN，不重建表**）+ BEFORE INSERT trigger 拒绝 NULL
  - mutation 写 `local_device_uuid` = 本机 `local_metadata.value WHERE key='device_uuid'`，`device_id` = 本机 `local_metadata.value WHERE key='skybridge_device_id'`（缺时 NULL，已 nullable 见 schema.ts:34）
  - apply 写 `local_device_uuid` = 本机 device_uuid，`device_id` = `ServerChange.deviceId`
  - 单机双 profile 测试：profile A 自己 emit 的 row 落库后 `local_device_uuid = A`、`device_id = A.skybridge_device_id`；profile B 拉到 A 的 row 落库后 `local_device_uuid = B`、`device_id = A.skybridge_device_id`
  - **sync_changes 不动**：现行 device_id NOT NULL 沿用 local uuid，**不加** local_device_uuid 列（与 device_id 等价）
- **B2 folder + conversation entity apply**
  - 五个新 entity/op：`folder/create` `folder/update` `folder/delete` `conversation/append` `conversation/delete`
  - `packages/core/src/sync/payloads/folder.ts` + `payloads/conversation.ts` apply-side payload validator
  - `packages/core/src/sync/engine.ts` 路由表加 folder / conversation 分支
- **B3 note tags + FTS apply**
  - 把 `syncNoteTags`（`packages/core/src/notes/index.ts:612`）从内部函数拎出来到 `packages/core/src/notes/tags.ts`，导出给 apply 路径复用
  - apply create / update 携带 `tags` 字段时，调用 `syncNoteTags` 重建 `note_tags` 并刷 `notes_fts.tags_text`
  - reminder：`/alarm` tag 入库后由现有 `syncReminders` 自动重建 `reminder_status`（apply 路径在每 note 处理完调一次）
- **B5 SSE 触发**
  - daemon 启动后注册 `client.subscribeEvents(workspaceId, { onChange })`，收到 `change` 事件即触发 `runManualSync`（走 §615e233 coalescer，已 ship）
  - 自动重连：SSE error 后退避 2s/4s/8s（cap 30s），到 max retry 切到"离线"状态但不退出 daemon
- **B6 GUI 同步状态栏 + 手动 sync 按钮**
  - 状态栏组件 `<SyncStatusBar />` 显示：当前 workspace / device 名 / 最近一次 sync 时间 / 状态徽章（idle / syncing / error / offline）
  - 手动 sync 按钮触发 daemon POST `/sync/run`
  - GUI 通过 daemon SSE `/events` 反向通道（P3.2-d 已有）订阅 `sync:status_changed` 事件
- **B7 自动化双 profile 集成测试**
  - `packages/daemon/src/sync/sync.dual.e2e.ts`：同进程起 skybridge server + 两个 owl core，跑完 §8.3 D1-D12 并断言
  - 文件名 `.dual.e2e.ts` 仍不被默认 test glob 抓到；`SKYBRIDGE_E2E=1` 时一起跑

### Out — 留给 P5-c / P6

- 后台定时同步 / 网络恢复触发 / SSE 之外的拉取策略
- 429 / 5xx 重试策略 / `conflict_record` 写入语义 / 冲突 UI
- 真实双机（两台物理机 + 真实远端 server）soak
- attachment 通道 / snapshot 拉取 / 多 workspace 切换
- keychain 替换明文 token

### 永不做

- CRDT / OT / P2P / 自动 merge

## 3. F4 device_id 命名空间统一（拍板：方案 b）

### 3.1 问题回顾

P5-a 验收暴露 `notes.device_id` 有两个 UUID 命名空间：

| 写入点 | 来源 | 值 |
|---|---|---|
| 本地 mutation（GUI / CLI）写 `notes.device_id` | `local_metadata.device_uuid`（`ensureDeviceId`） | 一个 owl 安装级 UUID |
| pull apply 写 `notes.device_id` | `ServerChange.deviceId`（skybridge `[device].id`） | 由 skybridge server 注册返回 |

同一台机器自己 emit 出去再 echo 回来时，cid 命中 self-replay 跳过；但**第二台**机器 apply 时把远端的 skybridge id 写进 `device_id` —— 等于本地 `notes` 表里有两类 `device_id`。语义混乱，UI 里没法稳定地"按设备过滤"。

### 3.2 方案 b：拆 `local_device_uuid` 列（含语义校准）

**评审反馈纠正**：
1. push 协议不含 device id 字段（owl `RealSkybridgeClient` 用 auth header / `x-device-id` 标识），所以 server 端 echo 判定不靠 `sync_changes.device_id`，靠 cid。"用 skybridge id 让 server 跳 echo" 这条路在 P5-a 当下根本走不通，本节按 review 收紧
2. `sync_changes.device_id` 在 0004 schema 是 `NOT NULL`，且 P5-a 已经全部填 `local_metadata.device_uuid`；保留语义不动
3. `sync_changes.local_device_uuid` 等于 `device_id`（本地 owl uuid），不要重复加列

**列语义最终拍板**：

| 列 | 类型 | 语义 | 写入 |
|---|---|---|---|
| `notes.local_device_uuid` | TEXT NOT NULL | "这一行物理上躺在哪台 owl 安装" | 本地 mutation：本机 `local_metadata.device_uuid`；apply：本机 `local_metadata.device_uuid`（永远本机） |
| `notes.device_id` | TEXT, 允许 NULL | "这一行最初由哪个 skybridge device 贡献" | 本地 mutation：本机 `skybridge_config.toml [device].id`，**缺 config 时为 NULL**；apply：`ServerChange.deviceId`（必填，server 协议保证） |
| `folders.local_device_uuid` / `folders.device_id` | 同上 | 同上 | 同上 |
| `sync_changes.device_id` | TEXT NOT NULL | 不变 — 本机 owl uuid，仅用作"emit 端归属调试" | emit：本机 `local_metadata.device_uuid` |

conversation 不加列（聊天本就不带 device 标记）。

**与 P5-a 的兼容性**：
- `notes.device_id` / `folders.device_id` 早就是 nullable（schema.ts:33 / :15）—— 不需要在 0006 改 column constraint
- P5-a 写入的 `device_id` 是 local uuid（owl 安装级），语义和 P5-b 想要的 skybridge id 不一致；但 migration 不破坏性 clear，由 `ensureSkybridgeSession` 拿到真 skybridge id 后做条件 backfill（§6.1）：`UPDATE WHERE device_id IS NULL OR device_id = local_device_uuid`，不覆盖已经被 apply 写过 skybridge id 的远端来源行

### 3.3 emit 路径的具体改动

**`[device].id` 的存放位置改 `local_metadata` 表**（不放 module cache）：

| key | value | 写入时机 |
|---|---|---|
| `device_uuid` | 本机 owl uuid | `ensureDeviceId` 启动时（既有） |
| `skybridge_device_id` | 本机 skybridge `[device].id` | `ensureSkybridgeSession` 在 `registerDevice` 成功后 INSERT OR REPLACE |
| `skybridge_workspace_id` | 本机 workspace id | 同上 |

**优势**：
- 每个 owl profile 有自己的 sqlite，自己的 `local_metadata` 表 → 双 profile 同进程 e2e 天然隔离
- mutation 读 device_id 全走 SQL（一条 SELECT 一次 join 都够），无 module-level 状态
- skybridge config 变化只在 register 时同步写一次到 `local_metadata`，toml 仍是 source of truth 但 mutation 不读它

mutation 在事务内写 `notes` / `folders` 行：
```ts
const meta = sqlite.prepare(
  `SELECT
     MAX(CASE WHEN key='device_uuid'         THEN value END) AS local_uuid,
     MAX(CASE WHEN key='skybridge_device_id' THEN value END) AS skybridge_id
   FROM local_metadata
   WHERE key IN ('device_uuid', 'skybridge_device_id')`
).get() as { local_uuid: string, skybridge_id: string | null };

// INSERT/UPDATE notes 时 local_device_uuid = meta.local_uuid, device_id = meta.skybridge_id
```

emit 路径（`emitSyncChange`，`packages/core/src/sync/changes.ts`）不变：`sync_changes.device_id` 继续填 `local_metadata.value WHERE key='device_uuid'`。

### 3.4 apply 路径的具体改动

`packages/core/src/sync/engine.ts` apply note / folder：

```sql
-- create / 不存在 → INSERT
INSERT INTO notes (id, ..., content, content_hash, local_device_uuid, device_id)
  VALUES (?, ?, ..., ?, ?, ?, ?)
-- update 不能用整列 upsert（见 §4.4 folder 同理），改用动态 UPDATE SET
```

- `local_device_uuid`：apply 时**永远写本机 `local_metadata.device_uuid`**（本机的，不是 push 那台的）。意义：apply 在本机执行，行物理上躺在本机
- `device_id`：apply 时写 `ServerChange.deviceId`（来源设备的 skybridge id）。意义：跨设备时能区分"我自己的"vs"别人的"
- 多设备场景：A 推 → server → B apply。B 的 `notes` 行：`local_device_uuid = B's local uuid`, `device_id = A's skybridge id`

### 3.5 migration v6（**ADD COLUMN + trigger**，**不**重建表）

**v2 表重建方案撤回**。原因：`note_tags.note_id` / `reminder_status.note_id` 都是 `ON DELETE CASCADE REFERENCES notes(id)`（`0001_initial.sql:48,59`），`DROP TABLE notes` 会触发 cascade 清空关联表。事务内不能临时 `PRAGMA foreign_keys = OFF`（migration runner 不支持脱事务）。本地复现：`note_tags` 被清空。

**v3 简化路径**：

```sql
-- 0006_device_id_split.sql

-- 1. 确保 device_uuid 存在（migration 可能比 ensureDeviceId 早跑）
INSERT OR IGNORE INTO local_metadata(key, value)
  VALUES ('device_uuid', lower(hex(randomblob(16))));

-- 2. ADD COLUMN（schema.ts:34 device_id 早就 nullable，本来就不需要改）
ALTER TABLE notes   ADD COLUMN local_device_uuid TEXT;
ALTER TABLE folders ADD COLUMN local_device_uuid TEXT;

-- 3. backfill 现有行
UPDATE notes   SET local_device_uuid =
  (SELECT value FROM local_metadata WHERE key = 'device_uuid');
UPDATE folders SET local_device_uuid =
  (SELECT value FROM local_metadata WHERE key = 'device_uuid');

-- 4. trigger 拒绝 NULL INSERT 和 NULL UPDATE
CREATE TRIGGER notes_local_device_uuid_not_null_insert
BEFORE INSERT ON notes
WHEN NEW.local_device_uuid IS NULL
BEGIN
  SELECT RAISE(ABORT, 'notes.local_device_uuid must not be null');
END;

CREATE TRIGGER notes_local_device_uuid_not_null_update
BEFORE UPDATE OF local_device_uuid ON notes
WHEN NEW.local_device_uuid IS NULL
BEGIN
  SELECT RAISE(ABORT, 'notes.local_device_uuid must not be set to null');
END;

CREATE TRIGGER folders_local_device_uuid_not_null_insert
BEFORE INSERT ON folders
WHEN NEW.local_device_uuid IS NULL
BEGIN
  SELECT RAISE(ABORT, 'folders.local_device_uuid must not be null');
END;

CREATE TRIGGER folders_local_device_uuid_not_null_update
BEFORE UPDATE OF local_device_uuid ON folders
WHEN NEW.local_device_uuid IS NULL
BEGIN
  SELECT RAISE(ABORT, 'folders.local_device_uuid must not be set to null');
END;

-- 5. notes.device_id 老值（旧 P5-a 写的 local uuid）migration 里不动；
--    `ensureSkybridgeSession` 拿到 skybridge id 后做非破坏性 backfill（§6.1），
--    把 device_id IS NULL 或 device_id = local_device_uuid 的行更新为 skybridge id。
```

**和 schema.ts 的对齐**：
- `notes.deviceId` 已 nullable（`schema.ts:33`，是 `text('device_id')` 不带 `.notNull()`），P5-b 不动
- `folders.deviceId` 也已 nullable（`schema.ts:15`）—— P5-b 不动
- `notes.contentHash` 也 nullable —— apply 路径继续派生，不依赖 NOT NULL
- `notes.position` 是 `real` nullable —— P5-a 已正确处理
- drizzle schema 加 `localDeviceUuid: text('local_device_uuid').notNull()` 让 TS 端 type-safe；运行时 NOT NULL 靠 INSERT + UPDATE 两个 trigger 兜底

**`table_info(notes).notnull = 1` 不追求**：trigger 已经在写入时拦下。读取端的 TS 类型靠 drizzle schema declare，运行时如果 trigger 失败就 throw（mutation transaction 整体回滚）。

**测试**：§9.3 显式断言：
- ADD COLUMN 后 schema column 出现
- 现有 notes / folders 行的 `local_device_uuid` 被 backfill
- INSERT note 不带 `local_device_uuid` → SQLite trigger RAISE ABORT
- UPDATE 把 `local_device_uuid` 改成 NULL → trigger RAISE ABORT
- `note_tags` / `reminder_status` 行数迁移前后不变（owl 仅这两张表通过 `ON DELETE CASCADE REFERENCES notes(id)` —— 0001_initial.sql:48 / :59；关键回归，防表重建方案的反面教材）

### 3.6 GUI 怎么显示

状态栏右侧的"设备"区显示 `skybridge_config.toml [device].name`（用户可改）。`local_device_uuid` 不展示给用户，只在日志和调试用。

## 4. folder + conversation apply 语义

### 4.1 entity / op 矩阵（扩展自 P5-a §3.1）

| entity | op | emit 当前形态 | apply（pull→local） |
|---|---|---|---|
| note | `create/update/trash/restore/delete` | 已就绪（P5-a） | ✓（P5-a） |
| **folder** | **`create`** | 已就绪 (`payload: {name, parent_id, position, created_at_ms, updated_at_ms}`) | **✓ B2** upsert LWW |
| **folder** | **`update`** | 已就绪 (sparse: `updated_at_ms` + 任意 `name`/`parent_id`/`position`) | **✓ B2** partial update LWW |
| **folder** | **`delete`** | P5-b 改 emit 为 `payload: { updated_at_ms }`（§4.3 方案 a） | **✓ B2** 物理删除 LWW |
| **conversation** | **`append`** | 已就绪 (`payload: {messages, applied_at_ms}` ± `title`/`created_at_ms`） | **✓ B2** sequence-merge（无 LWW） |
| **conversation** | **`delete`** | 已就绪 (`payload: {}`) | **✓ B2** cascade 删 |
| folder/conversation 其它 op | — | 不存在 | n/a |
| 其它 entity | — | 不存在（reminder_status / FTS 不入 sync_changes） | skip + cursor 推进（兜底） |

### 4.2 folder + note tag validator

`packages/core/src/sync/payloads/folder.ts`：

```ts
export interface FolderCreatePayload {
  name: string;
  parent_id: string | null;
  position: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface FolderUpdatePayload {
  updated_at_ms: number;
  name?: string;
  parent_id?: string | null;
  position?: number;
}

export interface FolderDeletePayload {
  updated_at_ms: number;        // §4.3 方案 a：emit 端补 nowMs
}

export type FolderApplyPayload =
  | { op: 'create'; payload: FolderCreatePayload }
  | { op: 'update'; payload: FolderUpdatePayload }
  | { op: 'delete'; payload: FolderDeletePayload };

export function parseFolderPayload(op: string, raw: unknown): FolderApplyPayload;
```

判定规则（参考 P5-a §3.1）：
1. `entity_type === 'folder'` 且 `payload.updated_at_ms` 不存在 → skip + log + cursor 推进（防御性，emit 端不应该出现这种 shape；老 P5-a 写的 `folder/delete` payload `{}` 会落进这里）
2. 存在 `updated_at_ms` → 跑 validator（按 op 走对应 shape），失败抛 → 整 batch 回滚

**note tag validator 加 enum 检查**（P5-a payloads/note.ts 的 `NoteTag.tag_type` 是 `string`，P5-b 真正落 apply 后必须收紧）：

```ts
// packages/core/src/sync/payloads/note.ts
import { TAG_TYPES, type TagType } from '../../tags/parser.js';
// TAG_TYPES 实际值见 packages/core/src/tags/parser.ts:8 —— 不在本 doc 硬编码避免漂移

export interface NoteTag {
  tag_type: TagType;            // 收紧为 parser.ts 的 enum
  tag_value: string | null;
}

// 验证函数：未知 tag_type → throw（整 batch 回滚），不是 skip
function assertTagType(t: unknown): TagType {
  if (typeof t !== 'string' || !(TAG_TYPES as readonly string[]).includes(t)) {
    throw new SkybridgeProtocolError(`unknown tag_type: ${String(t)}`);
  }
  return t as TagType;
}
```

`TAG_TYPES` 由 owl 现行 enum 决定，未来扩展 tag 类型只在 parser.ts 加，validator 自动跟动。**测试覆盖**：跑过 parser.ts 所有合法 tag_type 都不被拒；任一假 tag_type (`@todo` / `/done` / `/foo`) 触发 throw。

### 4.3 folder LWW（与 note 对齐，方案 a 拍板）

```
remote_ts = payload.updated_at_ms   (validator 已保证存在，含 delete)
local_ts  = SELECT updated_at FROM folders WHERE id = ? (本地不存在 = 0)

apply 条件：
  - self-replay：cid 命中本地 sync_changes synced_at IS NOT NULL → skip
  - op = 'create' 且本地不存在 → INSERT
  - op = 'delete' 且 local_ts > remote_ts → skip + log "deferred"
  - op != 'delete' 且 local_ts >= remote_ts → skip（tie 也跳过）
  - 否则 → apply
```

**delete payload contract 改动**（方案 a 落地）：`packages/core/src/folders/index.ts:226` 的 `deleteFolder` emit 改成：
```ts
emitSyncChange(sqlite, {
  entityType: 'folder',
  entityId: id,
  op: 'delete',
  payload: { updated_at_ms: nowMs },  // 原本是 {}
  nowMs,
});
```

这跟 P5-a Step 0b 给 `permanentDeleteNote` 加 `updated_at_ms` 的同形修复 —— LWW 锚点需要 remote_ts。

### 4.4 folder apply SQL（**create 用 INSERT，update 用动态 SET**）

**评审反馈纠正**：sparse update 不能走整列 upsert。`payload.parent_id === undefined` 时如果用 `excluded.parent_id` 会被 NULL 覆盖现有父级（drizzle bind undefined → NULL）。改成两路径：

```sql
-- create（payload 必有全字段，本地不存在该 id）
INSERT INTO folders
  (id, name, parent_id, position, created_at, updated_at, local_device_uuid, device_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?);

-- update（payload sparse，只写存在的字段；本地必存在）
UPDATE folders SET
  updated_at        = ?,
  local_device_uuid = ?,
  device_id         = ?
  [, name              = ?]            -- if payload.name !== undefined
  [, parent_id         = ?]            -- if payload.parent_id !== undefined（含 null）
  [, position          = ?]            -- if payload.position !== undefined
  WHERE id = ?;

-- delete
DELETE FROM folders WHERE id = ?;
```

**实现**：apply 端用 JS 构造 SQL 字符串，按 `payload` 中实际出现的 key 拼 `SET` 子句。和现有 `updateFolder`（`packages/core/src/folders/index.ts:151-157`）的动态 set 形态对齐，复制即可。

**`local_device_uuid` / `device_id` 永远写**：每次 apply 都覆盖（apply 行为本身就是"本机最新接管这一行"的语义）。

**已知差异**：emit 路径的 `deleteFolder` 有 5 步算法（先 reparent children 再 delete）。apply 端**不**复刻这 5 步 —— remote 已经把 children 的 reparent 拆成单独的 `folder/update` rows push 上来了（P4 Phase 2 unchanged contract），按 server_seq 顺序回放自然到位。**前提是 push batch 顺序保留**，由 server 写入顺序保证（server_seq 单调）。

**notes 同处理**：P5-a 现有 apply 路径用整列 upsert（`packages/core/src/sync/engine.ts` `applyNoteChange`），对 note 来说原代码 update 路径的 sparse 处理是 SELECT 现行 + 字段合并再 upsert（参考 design v6 §7.4）。P5-b 把 note update 也改成动态 SET，与 folder 对齐，去掉 SELECT 中间一步，commit 顺手做。

### 4.5 conversation payload validator

```ts
export interface ConversationAppendPayload {
  messages: ConversationMessageRow[];
  applied_at_ms: number;
  title?: string;          // 首次 append 才带
  created_at_ms?: number;  // 首次 append 才带
}

export type ConversationApplyPayload =
  | { op: 'append'; payload: ConversationAppendPayload }
  | { op: 'delete'; payload: Record<string, never> };
```

`ConversationMessageRow` 字段对齐 `packages/core/src/conversations/types.ts`：role / content / tool_calls / tool_call_id / is_error / reasoning_content / reasoning_signature。

### 4.6 conversation apply 语义（**change 级幂等，message 级幂等留 P5-c**）

**评审反馈纠正**：
1. `ai_messages` 实际 schema：`id TEXT PRIMARY KEY`，`(conversation_id, seq)` 只是普通 index（0003_ai_chat.sql:24），**seq 不会冲突回滚**
2. emit payload 的 `messages` 不带原始 seq（`packages/core/src/conversations/index.ts:77-91` 的 emit 形态）
3. 因此"靠 seq 冲突 retry" / "靠 (role, content) hash 去重"都不可行；hash 去重还会误删合法重复消息（用户连发两条 "ok"）

**P5-b 落地的语义**：
- **change 级幂等靠 cid**：本机自己 emit + push 的 conversation/append，pull 回来 cid 命中 self-replay → skip。够覆盖单设备场景
- **跨设备 append 直接追加**：不去重。payload.messages 整段追加到 ai_messages 末尾，seq 在本机重新递增。可能产生"客观重复" —— A 写 ok / B 写 ok / 互相 pull → 两侧各看到两条 ok（一条 A 一条 B 的，不是错）
- **message 级幂等留 P5-c**：届时给 `ai_messages` 加全局 `message_id`（emit 时一起带），apply 端按 message_id INSERT OR IGNORE

```
apply:
  1. self-replay：cid 命中本地 sync_changes synced_at IS NOT NULL → skip（覆盖本机回环）
  2. op = 'append' 且本地不存在该 conversation row：
     - 用 payload.title + payload.created_at_ms INSERT ai_conversations
     - 用 insertMessages 接 payload.messages 到末尾（seq 从 1 起递增）
     - bumpUpdatedAt 到 payload.applied_at_ms
  3. op = 'append' 且本地存在：
     - 不动 title / created_at
     - 用 insertMessages 接 payload.messages 到末尾（seq 接 peekMaxSeq + 1 起）
     - bumpUpdatedAt 到 payload.applied_at_ms
  4. op = 'delete' → DELETE FROM ai_conversations WHERE id = ?（FK cascade 清 messages）
```

**已知差异**（明示，不在 P5-b 修）：
- 双设备并发追加 → 两侧各落两份对方那段消息（不是同一段的两份）
- 单设备自己重 sync → cid 命中跳过，不会重复
- 用户视角："两台机器写过的话，等同步完两边都能看到对方写的内容，但没有交错合并 —— B 在 A 之前写的内容会出现在 A 之后写的内容**前面**还是**后面**取决于 server_seq 顺序"

**测试覆盖**：D9 改为断言"双 profile 各 append 一段，最终两侧 ai_messages 各包含两段、顺序按 server_seq"。**不再**测 seq 冲突 retry。

### 4.7 router 更新

`packages/core/src/sync/engine.ts` 现在的 `applyNoteChange` 改成 `applyChange(deps, change)`，内部按 `entity_type` 分发：

```ts
switch (change.entityType) {
  case 'note':         return applyNoteChange(deps, change);
  case 'folder':       return applyFolderChange(deps, change);
  case 'conversation': return applyConversationChange(deps, change);
  default:
    deps.logger.info({ ... }, '[sync] apply skip — unknown entity_type');
    return { status: 'skipped', reason: 'unknown_entity' };
}
```

cursor 推进逻辑不动（per-change `pulled_seq = MAX(pulled_seq, server_seq)`）。

## 5. note tags + FTS apply

### 5.1 抽 `syncNoteTags` 到独立模块

当前 `syncNoteTags` 是 `packages/core/src/notes/index.ts:612` 的私有 helper，签名：

```ts
function syncNoteTags(
  db: OwlDatabase,
  sqlite: Database.Database,
  noteId: string,
  parsedTags: ParsedTag[],
): void
```

抽到 `packages/core/src/notes/tags.ts` 并 export。`ParsedTag` 已经在 `tags/parser.ts` 导出，apply 端从 payload 的 `tags: NoteTag[]` 映射到 `ParsedTag[]` 即可。`NoteTag.tag_value` 是 `string | null`，`ParsedTag.tagValue` 是 `string`（非空）。映射时 `tagValue ?? ''` 兜底，避免 type mismatch。

### 5.2 RunSyncDeps 扩展（**db 必须注入**）

**评审反馈纠正**：现有 `RunSyncDeps`（`packages/core/src/sync/engine.ts:91`）只有 `sqlite`，但 `syncNoteTags` / `syncReminders` 都吃 `OwlDatabase`。P5-b 必须扩：

```ts
export interface RunSyncDeps {
  db: OwlDatabase;            // ← 新增
  sqlite: Database.Database;
  client: SkybridgeClientLike;
  workspaceId: string;
  serverUrl: string;
  nowMs?: () => number;
  logger?: RunSyncLogger;
}
```

daemon `packages/daemon/src/sync/manual.ts` 调 `runSync` 时把 `ctx.db` 传进去（`AppContext` 已有 `db: OwlDatabase`）。Fake client 单测里需要起一个 drizzle wrapping 同一个 `:memory:` sqlite —— `packages/core/src/db/index.ts` 的 `createDatabase` 既然返回 `{ db, sqlite }`，单测里直接复用即可。

### 5.3 apply 路径调用

`applyNoteChange` 内 create / update 改完之后：

```ts
if ('tags' in b && Array.isArray(b.tags)) {
  const parsed: ParsedTag[] = b.tags.map(t => ({
    tagType:  t.tag_type,
    tagValue: t.tag_value ?? '',
  }));
  syncNoteTags(deps.db, deps.sqlite, c.entityId, parsed);
}
```

- create：payload 必含 `tags` 字段（即使空 array）
- update：payload sparse —— `tags` 可能不存在，不存在就不动 `note_tags`

注意 `syncNoteTags` 内部已经维护 `notes_fts.tags_text`，apply 不用单独刷 FTS。

### 5.4 reminder 重建

`syncNoteTags` 跑完后，每 note apply 完调一次：

```ts
syncReminders(deps.db, deps.sqlite, c.entityId);
```

`syncReminders`（`packages/core/src/reminders/index.ts:36`）已经是幂等的（按当前 `/alarm` tag 状态 reconcile `reminder_status`）。

**Scheduler 重扫钩子**：`runManualSync` 成功返回后由 `manual.ts` **直接调** `ctx.scheduler.reload()`（不走 OwlEvent，理由见 §6.3）。`appliedTotal > 0` 时再 reload 是可选优化，保守版每次都 reload。

### 5.5 FTS rebuild 是否需要

P3.4 时确认 `notes_fts.content` 由 trigger 自动同步，`tags_text` 由业务层维护。apply 路径：
- content 改了 → trigger 自动刷 `notes_fts.content`
- tags 改了 → `syncNoteTags` 内部刷 `notes_fts.tags_text`

不需要单独 rebuild。验证用 §13.4 第 7 步 "B 端 FTS 搜 A 创建 note 的 #tag 命中" 兜底。

## 6. SSE 订阅 → daemon → GUI

### 6.1 前提：抽 `ensureSkybridgeSession(ctx)` helper

**评审反馈纠正**：当前 daemon `packages/daemon/src/sync/manual.ts:294` 的 `doRunManualSync()` 内部一次性做了：
1. 读 `skybridge_config.toml`
2. dynamic import `@skybridge/client` 拿 `RealSkybridgeClient`
3. login 兜底 / registerDevice / ensureWorkspace
4. adapt 到 `SkybridgeClientLike`
5. 跑 `runSync(deps)`

要让 sse-bridge 和 manual sync 共享同一 session（同一 client 实例 + 已 register 的 device + workspace id），必须先抽：

```ts
// packages/daemon/src/sync/session.ts （新）
import type { SkybridgeClientLike } from '@owl/core';

// 不从 './manual.js' import RealSkybridgeClient —— 那是 doRunManualSync 内部用的 local interface
// session.ts 把这个 interface 抽出来导出（manual.ts 改为从 session.ts import）：
export interface RealSkybridgeClient { /* push / pull / subscribeEvents / ... */ }

export interface SkybridgeSession {
  realClient: RealSkybridgeClient;        // 给 sse-bridge 用（需要 subscribeEvents）
  syncClient: SkybridgeClientLike;        // adapter 给 runSync 用
  config: SkybridgeConfig;
  workspaceId: string;
  deviceId: string;
}

export async function ensureSkybridgeSession(ctx: AppContext): Promise<SkybridgeSession>;
```

- 内部读 config → dynamic import → login（若 token expire）→ registerDevice / 复用 toml 已有 device.id → ensureWorkspace
- **每次** `ensureSkybridgeSession` 拿到最终 `config.device.id` / `workspace.id` 后都 INSERT OR REPLACE 写入**该 profile 的** `local_metadata`（key=`skybridge_device_id` / `skybridge_workspace_id`），不依赖"register 是否真发生"
- 顺势做**非破坏性 device_id backfill**（仅一次，由 `local_metadata.skybridge_backfilled` 标记）：
  ```sql
  UPDATE notes   SET device_id = ?skybridge_id
    WHERE device_id IS NULL OR device_id = ?local_device_uuid;
  UPDATE folders SET device_id = ?skybridge_id
    WHERE device_id IS NULL OR device_id = ?local_device_uuid;
  INSERT OR REPLACE INTO local_metadata(key, value) VALUES ('skybridge_backfilled', '1');
  ```
  这保证不覆盖已被 apply 写过的远端来源行（apply 已经填了真正的 skybridge device id，不会撞 local_device_uuid）
- daemon 启动时调用一次，session 缓存在 **`AppContext`-scoped 字段**（`ctx.skybridgeSession`），不是 module-level —— 避免双 profile 同进程串
- session invalidate（401 / SkybridgeAuthRequired）时 `ctx.skybridgeSession = null`，下次 manual sync 重 ensure

`doRunManualSync()` 改为 `const session = await ensureSkybridgeSession(ctx); await runSync({ ..., client: session.syncClient, workspaceId: session.workspaceId });`。

### 6.2 daemon 端：订阅 + 触发

**前提改动**：`SkybridgeClientLike` 当前没有 `subscribeEvents`（`packages/core/src/sync/engine.ts` 接口），但实际 `@skybridge/client` 有（`packages/client/src/client.ts:158`）。两种处理：

- (a) 把 `subscribeEvents` 加进 `SkybridgeClientLike` —— 但 core 单测 Fake client 也要实现
- (b) sse-bridge 直接用 `RealSkybridgeClient`（不走 adapter），订阅是 daemon-only 功能不需要 core 抽象

倾向 **(b)**：sse-bridge 是 daemon 关注，core 不该知道 SSE 存在。`SkybridgeSession` 把 `realClient` 暴露出来给 sse-bridge。

`packages/daemon/src/sync/sse-bridge.ts`（新文件）：

```ts
import type { RealSkybridgeClient } from './session.js';   // session.ts 导出，不从 manual.js 拿
import { runManualSync } from './manual.js';
import type { AppContext } from '../context.js';

interface SseBridgeOptions {
  realClient: RealSkybridgeClient;
  workspaceId: string;
  ctx: AppContext;
  logger: Logger;
}

interface SseBridge {
  start(): void;
  stop(): void;
}

export function createSseBridge(opts: SseBridgeOptions): SseBridge {
  let unsubscribe: (() => void) | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryAttempt = 0;
  let stopped = false;

  function jitter(ms: number): number { return ms + Math.floor(Math.random() * 1000); }

  function connect(): void {
    if (stopped) return;
    unsubscribe = opts.realClient.subscribeEvents(opts.workspaceId, {
      onChange: async (latestSeq) => {
        opts.logger.info({ latestSeq }, '[sse] change event');
        try {
          await runManualSync(opts.ctx);  // F3 coalescer 已 ship
        } catch (err) {
          opts.logger.warn({ err }, '[sse] runManualSync failed');
        }
      },
      onOpen: () => {
        retryAttempt = 0;
        opts.logger.info({}, '[sse] connected');
        emitSyncStatus(opts.ctx, { state: 'idle' });
        // **catch-up sync**：server SSE 不重放断连期间的 change event
        // （proto/events.ts 只发 latest_seq，不带历史）。所以每次 (re)connect
        // 都要主动跑一次 manual sync，把离线期间积累的 change 拉下来。
        runManualSync(opts.ctx).catch((err) =>
          opts.logger.warn({ err }, '[sse] reconnect catch-up sync failed')
        );
      },
      onError: (err) => {
        opts.logger.warn({ err: err.message }, '[sse] error, will retry');
        emitSyncStatus(opts.ctx, { state: 'offline', lastError: err.message });
        scheduleReconnect();
      },
    });
  }

  function scheduleReconnect(): void {
    if (stopped || retryTimer) return;
    // 2/4/8/16/30s + 0-1s jitter，持续重连永不停（P5-c 才考虑彻底放弃）
    const base = Math.min(2000 * Math.pow(2, retryAttempt), 30_000);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, jitter(base));
    retryTimer.unref();
  }

  return {
    start: () => connect(),
    stop: () => {
      stopped = true;
      unsubscribe?.();
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}
```

**启动时机**：daemon main 启动后 → `ensureSkybridgeSession` 成功后 → `createSseBridge(...).start()`。daemon shutdown hook 调 `sseBridge.stop()`。

### 6.3 GUI 端：daemon SSE 反向通道

daemon `/events` SSE（P3.2-d）已有；GUI 用 `packages/gui/src/renderer/src/components/EventsSubscriber.tsx` + `events-subscriber-core.ts` 消费。`OwlEvent`（`packages/daemon/src/events/types.ts:17`）是**单一通道**，emit 即广播给 GUI，所以 P5-b 只往这个 union 加**外部**事件：

**SyncStatus shape 统一**：现有 `/sync/status` (manual.ts:433) 返回 `SyncStatusResult { configured, authenticated, server_url, device_id, workspace_id, pending_count, pulled_seq, pushed_seq, last_sync_at }`，是 snake_case + 仅事实字段。P5-b 引入的 SyncStatus（带 state / lastError）是 GUI 视角的聚合状态。两种处理：
- (a) 让 `/sync/status` 也返回新 SyncStatus shape（破坏 P5-a 现有调用方）
- (b) 新建 `SyncStatusEvent` 聚合 type，SSE 发它；`/sync/status` 保留原 shape；GUI 首屏 fetch `/sync/status` 后做 adapter 映射到 store

倾向 **(b)**：P5-a `/sync/status` 已有 CLI 调用方（`owl sync status`），破坏不划算。设计如下：

```ts
// packages/daemon/src/events/types.ts（扩 OwlEvent union）
export type OwlEvent =
  | { type: 'note:updated', id: string }
  | ...
  | { type: 'sync:status_changed', status: SyncStatusSnapshot };

// daemon 端的"实时"聚合（不持久化）—— 由 runManualSync / sse-bridge 维护：
export interface SyncStatusSnapshot {
  state: 'idle' | 'syncing' | 'error' | 'offline';
  /** 字段命名沿用 SyncStatusResult 的 snake_case 保持一致 */
  server_url: string | null;
  device_id: string | null;
  workspace_id: string | null;
  pending_count: number;
  pulled_seq: number;
  pushed_seq: number;
  last_sync_at: number | null;
  last_error: string | null;
}
```

- daemon module-scoped（per-AppContext via ctx field 或 closure，避免双 profile 串）`syncStatusSnapshot: SyncStatusSnapshot`
- `runManualSync` 进入时 mutate `state='syncing'`，完成 mutate `state='idle' | 'error'` + 更新 cursor / last_sync_at / last_error / pending_count
- sse-bridge `onOpen` / `onError` mutate `state`
- 每次 mutate 后 `ctx.eventsBus.emit({ type: 'sync:status_changed', status: snapshot })`
- GUI：首屏 `fetch /sync/status` → 用 SyncStatusResult adapter 出 `state='idle'` 初始 snapshot 灌进 store；之后由 SSE 增量更新

**事件命名拍板（v4 修正）**：
- 外部 SSE（OwlEvent / `/events`）：仅 `sync:status_changed`，发给 GUI
- daemon 内部联动（reminder scheduler reload）：**不**走 OwlEvent 通道，避免泄露给 GUI。改为 `runManualSync` 成功后**直接调** `ctx.scheduler.reload()`（同步调用，scheduler 已暴露 reload）
- 这样不需要新建 internal bus，单一通道职责清晰

### 6.4 GUI store

`packages/gui/src/renderer/src/stores/sync-status.ts`（新）：

```ts
import { create } from 'zustand';

interface SyncStatusState {
  status: SyncStatus | null;
  setStatus: (s: SyncStatus) => void;
}

export const useSyncStatus = create<SyncStatusState>(...);
```

在 `events-subscriber-core.ts` 加 `sync:status_changed` 分支 → `useSyncStatus.getState().setStatus(event.status)`。

### 6.5 跨页面感知

P5-b 范围内**不**因为 sync apply 触发自动刷新 note 列表 —— `bumpNotes()` / `bumpFolders()` 只由本地 mutation 调（避免远端 push 一进来 GUI 就抢用户视图）。状态栏显示"刚收到 12 条更新，点击刷新"按钮，用户主动触发再 bump。

**未来 P5-c**：考虑根据当前打开的 tab 智能 bump（编辑器开着的 note 被远端改了，提示"远端有更新，要 reload 吗"），P5-b 不做。

## 7. GUI 同步状态栏 + 手动 sync 按钮

### 7.1 组件位置

owl 编辑器底部已有 status info（字数 / 行号等），`<SyncStatusBar />` 嵌入**同一行右侧**，不单独占一行。窄宽度时折叠成图标 + popover（参考 `NoteListItem` 的 container query 处理，`@[380px]:` 类似）。

### 7.2 设计

宽屏（>= 480px 可用空间）：
```
[● syncing | 12:34] [device: jay-mac] [↻]
```

窄屏（< 480px）：
```
[●] [↻]      ← hover 出 popover 显示完整信息（workspace / device / lastSyncedAt / lastError / cursor）
```

- `●` 颜色：idle=灰 / syncing=蓝（带 spin）/ error=红 / offline=橙
- `12:34` 来自 `SyncStatusSnapshot.last_sync_at`（相对 / 绝对自适应）
- device 名：GUI 从 `skybridge_config.toml [device].name` 读（CLI 也用同名 endpoint 可选，P5-b 不强制）；`device_id` 仅 popover 中以 monospace 展示
- `↻` 按钮：POST `/sync/run`（disabled 当 `state='syncing'`）
- 错误状态点击展开 `AlertDialog` 显示完整 `last_error`

### 7.3 API

GUI fetch：
- `GET /sync/status` —— 现成（P5-a）
- `POST /sync/run` —— 现成
- `/events` SSE —— 现成 + 新增 `sync:status_changed`

### 7.4 设计细节

- 状态徽章用 shadcn `Badge` + 自定义 variant（按颜色）
- spinner 用 `lucide-react` 的 `RotateCw` + Tailwind `animate-spin`
- popover 用 shadcn `Popover`
- 容器宽度感知用 Tailwind v4 container query（`@container` + `@[480px]:flex` 等）
- 错误状态点击展开 `AlertDialog` 显示完整错误

## 8. 自动化双 profile 集成测试

### 8.1 文件位置 + 命名

`packages/daemon/src/sync/sync.dual.e2e.ts`：
- 不带 `.test.`，默认 test glob 不抓
- suite 顶层 `{ skip: !process.env.SKYBRIDGE_E2E }`
- 运行：`SKYBRIDGE_E2E=1 pnpm --filter @owl/daemon test:e2e`

### 8.2 框架

单进程内：
- in-memory skybridge server（dynamic import `@skybridge/server`，参考 P5-a §8.3）
- 两个 owl core 实例，各自 :memory: sqlite + 独立 `skybridge_config.toml` 临时目录
- 通过本地 HTTP 桥接（fastify localhost）调 server endpoints

### 8.3 测试矩阵

| # | 验证 | 断言 |
|---|---|---|
| D1 | A login + register → toml 写入 | toml 文件存在，`[device].id` 非空 |
| D2 | A 创建 note + folder + conversation + tags → emit sync_changes | sync_changes 行数 = N，cid 唯一 |
| D3 | A 首次 sync → push 全部 pending | pushedTotal = N，server_seq 单调 |
| D4 | A self-replay → 全 skip | pulledTotal=N，appliedTotal=0，skippedTotal=N |
| D5 | B login + register + 首次 sync | B `notes` / `folders` 出现 A 的行；B `note_tags` 出现 A 的 tags；B `notes_fts.tags_text` 出现 hash tags |
| D6 | B 改 A 创建的 note → push | pushedTotal=1，server_seq=N+1 |
| D7 | A pull B 的 edit | A 行的 content 更新；`local_device_uuid` 仍是 A，`device_id` 变成 B |
| D8 | A 删 folder | A emit folder/delete；B pull 后 B 的 folder 行消失，子 folder 被 reparent；B 中 notes.folder_id 变 NULL（FK） |
| D9 | A 和 B 各 append 一段到同一 conversation | 两轮互相 sync 后，两侧 ai_messages 各包含两段，**顺序按 server_seq**（不强求"逻辑合并"，**不**做去重） |
| D10 | A reminder（/alarm tag）→ B apply | B `reminder_status` 出现 pending row，fire_at 一致 |
| D11 | B 离线期间 A push → B SSE 重连 | sse-bridge `onOpen` catch-up sync 在 reconnect 后 100ms 内跑一次 runManualSync，B 收齐 A 的 change（监听 `sync:status_changed` 跑完进入 idle） |
| D11b | B 在线时 A push | SSE `onChange` 触发 runManualSync，B 100ms 内 applied A 的 change |
| D12 | server 主动 close SSE → bridge 自动重连 | retry attempt 计数器 1→2→3 |

每个用例独立 setup / teardown（清 :memory: db + 重置 server state）。

### 8.4 跑时长目标

单次跑全套 D1-D12 < 30s（local memory + HTTP roundtrip 应该很快）。CI 上接入 `just test:e2e`（**不**默认跑，需要 env）。

### 8.5 替代价值

P5-a 的 §13 手动验收 8 步**完整收编**为 D1-D8。D9-D12 是 P5-b 新增能力。P5-b 验收时人手只需要：
1. 跑 `SKYBRIDGE_E2E=1 just test:e2e` 全绿
2. 跑一次 `just dev-skybridge` + GUI 看状态栏（视觉验证，无法自动化）

## 9. schema v6 migration

### 9.1 `0006_device_id_split.sql` 内容

见 §3.5。要点重申：
- `local_metadata` 是 key/value 表，backfill 用 `WHERE key = 'device_uuid'` / `INSERT OR IGNORE INTO local_metadata(key, value) VALUES ('device_uuid', ...)`
- `sync_changes` 表不动（保留 `device_id NOT NULL`，沿用 local uuid）
- notes / folders **ADD COLUMN local_device_uuid + backfill + BEFORE INSERT / BEFORE UPDATE trigger**（不重建表）
- `device_id` 早就 nullable（schema.ts:15 / :33），不需要改
- `device_id` 旧值（local uuid）不在 migration 里破坏性 clear；由 `ensureSkybridgeSession` 拿到真 skybridge id 后做非破坏性 backfill（§6.1）

### 9.2 LATEST_KNOWN_VERSION 

`packages/core/src/db/migrate.ts:47`：`LATEST_KNOWN_VERSION = 5` → `6`。`migration-ipc.test.ts` / `migration-precheck.test.ts` 读这个常量不是字面量，自动跟动。

### 9.3 0006 测试

`packages/core/src/db/migrations/0006_device_id_split.test.ts`：
- v5 库（含若干 notes / folders / note_tags / reminder_status / sync_changes 行）上跑 0006
- notes / folders 表加出 `local_device_uuid` 列
- 现有行 `local_device_uuid` 等于 `local_metadata.value WHERE key='device_uuid'`
- 现有行 `device_id` 保留旧值（不动）
- INSERT 新 note / folder 不带 `local_device_uuid` → trigger RAISE ABORT
- **关键回归**：`note_tags` / `reminder_status` 行数迁移前后**完全不变**（防表重建方案的 cascade 风险）
- FTS 触发器 / 索引未受影响：迁移后跑一个 FTS MATCH 查询能命中旧 note
- sync_changes 表行数 / `device_id` 值不变

## 10. 文件改动清单

| 文件 | 改动 |
|---|---|
| `packages/core/src/db/migrations/0006_device_id_split.sql` | 新建（§9.1）—— **ADD COLUMN + trigger**，不重建表 |
| `packages/core/src/db/migrate.ts:47` | `LATEST_KNOWN_VERSION = 5 → 6` |
| `packages/core/src/db/schema.ts` | notes / folders 加 `localDeviceUuid: text(...).notNull()`（TS-side），sync_changes 不动 |
| `packages/core/src/sync/changes.ts` | 不动（`sync_changes.device_id` 仍是 local uuid） |
| `packages/core/src/notes/index.ts` / `folders/index.ts` | mutation INSERT/UPDATE 时读 `local_metadata`（一条 SELECT 拿 local_uuid + skybridge_id）→ 写 `local_device_uuid` / `device_id` |
| `packages/core/src/folders/index.ts:226` | `deleteFolder` emit payload 加 `updated_at_ms`（§4.3 方案 a） |
| `packages/core/src/sync/engine.ts` | RunSyncDeps 加 `db`；router 分发；note update 改动态 SET；apply note 加 tags + reminder；apply folder + conversation |
| `packages/core/src/sync/payloads/note.ts` | tags 字段收紧 `tag_type` 为 `TagType` enum（import from `tags/parser.js`）；未知值 throw `SkybridgeProtocolError`（§4.2） |
| `packages/core/src/sync/payloads/folder.ts` | 新建（含 `FolderDeletePayload { updated_at_ms }`） |
| `packages/core/src/sync/payloads/conversation.ts` | 新建 |
| `packages/core/src/notes/tags.ts` | 抽出 `syncNoteTags` |
| `packages/core/src/notes/index.ts:612` | 删除内部 `syncNoteTags`，import from `./tags.js` |
| `packages/daemon/src/sync/session.ts` | 新建：`ensureSkybridgeSession(ctx)`，`registerDevice` 成功时把 `[device].id` / `workspace.id` INSERT OR REPLACE 进 `local_metadata`（不做 module cache） |
| `packages/daemon/src/sync/sse-bridge.ts` | 新建（§6.2，含 onOpen catch-up sync） |
| `packages/daemon/src/sync/manual.ts` | 复用 `ensureSkybridgeSession`；`runManualSync` emit `sync:status_changed` 到 OwlEvent；成功后**直接调** `ctx.scheduler.reload()`（不走 event 通道，§6.3） |
| `packages/daemon/src/server.ts`（启动入口） | 启动后调 `ensureSkybridgeSession` + 启动 sse-bridge；shutdown hook stop |
| `packages/daemon/src/events/types.ts:17` | `OwlEvent` union 加 `sync:status_changed` 一项；不加内部专用 event（避免泄漏给 GUI） |
| `packages/daemon/src/events/bus.ts` | 类型自动跟动；无新方法 |
| `packages/daemon/src/sync/sync.dual.e2e.ts` | 新建（§8） |
| `packages/daemon/src/scheduler.ts` | 加 `reload()`；不订阅事件，由 `runManualSync` 直接调（§5.4 / §6.3） |
| `packages/daemon/src/context.ts:11` | `AppContext` 加 `skybridgeSession: SkybridgeSession \| null` 字段（默认 null，由 `ensureSkybridgeSession` 写入；invalidate 时清空） |
| `packages/gui/src/renderer/src/components/sync/SyncStatusBar.tsx` | 新建（§7） |
| `packages/gui/src/renderer/src/stores/sync-status.ts` | 新建 |
| `packages/gui/src/renderer/src/components/events-subscriber-core.ts` | 加 `sync:status_changed` 分支 |
| `packages/gui/src/renderer/src/components/EditorPanel.tsx`（status bar 所在文件） | 嵌入 `<SyncStatusBar />` 同一行右侧 |

## 11. 顺序与产出 commits

| 顺序 | 仓 | 改动 | scope |
|---|---|---|---|
| **1** | owl | schema v6 migration + 测试 + schema.ts 字段 | `db` |
| **2** | owl | `notes` / `folders` mutation INSERT/UPDATE 时一条 SELECT 拿 `local_metadata.{device_uuid, skybridge_device_id}` 写入两列；`emitSyncChange` 不动；现有 mutation 单测更新（断言 `local_device_uuid` 落 row） | `skybridge` / `notes` / `folders` |
| **3** | owl | `deleteFolder` emit payload 加 `updated_at_ms`（§4.3 方案 a） | `notes` |
| **4** | owl | 抽 `syncNoteTags` 到 `packages/core/src/notes/tags.ts`；index.ts 改 import；现有 note 测试不动 | `notes` |
| **5** | owl | `payloads/folder.ts` + `payloads/conversation.ts` validators + 单测 | `skybridge` |
| **6** | owl | `sync/engine.ts` 拆 router + applyFolderChange + applyConversationChange + applyNoteChange 加 tags/reminder 调用；Fake client 单测扩 | `skybridge` |
| **7** | owl | `sync/sse-bridge.ts` + 单测（Fake client）；`sync/manual.ts` 启动 bridge | `daemon` |
| **8** | owl | OwlEvent union 加 `sync:status_changed`；reminder scheduler `reload()`；`runManualSync` 成功后直接调 reload | `daemon` / `reminders` |
| **9** | owl | GUI `<SyncStatusBar />` + store + daemon-events 分支；container 挂载；vitest UI 测试 | `gui` |
| **10** | owl | `sync.dual.e2e.ts` 实施 D1-D12；接 `just test:e2e` 路径 | `daemon` |
| **11** | owl + aviary | 文档统一（§14） | docs |
| **12** | n/a | 自动化测试 `SKYBRIDGE_E2E=1 just test:e2e` 全绿验收；GUI 视觉验证 | n/a |

**关键约束**：
- Step 1 / 2 / 3 必须在 Step 6 之前 —— apply 端读两个 UUID + folder delete payload 依赖前置
- Step 4 在 Step 6 之前 —— `syncNoteTags` 模块路径稳定后才好在 apply 调
- Step 7（sse-bridge）和 Step 9（GUI）相对独立可并行，但 Step 7 落后会让 Step 10 D11 / D12 没法测；建议 7 先于 9
- Step 10 必须最后 —— 依赖全部前置

不发版 / 不 tag / 不 publish。完成后 `PROCESS.md` 标 "P5-b shipped (内部)"，0.5.0 仍留给 P5-c。

## 12. 测试矩阵

### 12.1 core 单测（node:test）

| 测试 | 文件 | 覆盖 |
|---|---|---|
| `0006` migration | `db/migrations/0006_device_id_split.test.ts` | §9.3 |
| folder payload validator | `sync/payloads/folder.test.ts` | create / update / delete shape + invalid 拒绝 |
| conversation payload validator | `sync/payloads/conversation.test.ts` | append / delete shape + invalid 拒绝 |
| engine router | `sync/engine.test.ts`（扩 P5-a 已有） | folder / conversation 分发；unknown entity skip |
| engine apply folder LWW | 同上 | create / update partial / delete + LWW 各路径 |
| engine apply conversation merge | 同上 | append 首次 / 续 append / 去重 / delete cascade |
| engine apply note tags | 同上 | tags 写 note_tags + tags_text |
| engine apply note reminder | 同上 | /alarm tag → reminder_status pending |
| mutation 写两列 | `notes/index.test.ts` / `folders/index.test.ts` | INSERT/UPDATE 后 row 的 `local_device_uuid` 来自 `local_metadata`；`device_id` 来自 skybridge_device_id（NULL 当不存在）|
| `syncNoteTags` 抽离 | `notes/tags.test.ts` | 单独 export，行为不变 |
| note tag_type enum 拒绝未知值 | `sync/payloads/note.test.ts` | unknown tag_type → SkybridgeProtocolError throw |

### 12.2 daemon 单测（node:test）

| 测试 | 文件 | 覆盖 |
|---|---|---|
| sse-bridge connect + onChange | `sync/sse-bridge.test.ts` | Fake client 触发 onChange → runManualSync 被调 |
| sse-bridge 重连退避 | 同上 | onError 后 2s/4s/8s/cap 30s |
| sse-bridge stop | 同上 | unsubscribe + clearTimeout |
| daemon `/events` 加 sync:status_changed | `events/bus.test.ts` | emit + consumer 收到 |
| `runManualSync` 成功直接调 scheduler.reload | `sync/manual.test.ts` | mock ctx.scheduler.reload，断言 success 时被调一次 |
| reminder scheduler reload 方法 | `scheduler.test.ts` | reload() 重扫 reminder_status 并重排调度 |
| `ensureSkybridgeSession` 写 local_metadata + backfill | `sync/session.test.ts` | session 成功后 metadata 含 `skybridge_device_id`；首次时 backfill 命中 `device_id IS NULL OR = local_device_uuid` 的行，不动 apply 写过的远端行；`skybridge_backfilled=1` 后不再重跑 |

### 12.3 GUI vitest

| 测试 | 文件 | 覆盖 |
|---|---|---|
| SyncStatusBar 渲染各状态 | `components/sync/SyncStatusBar.test.tsx` | idle / syncing / error / offline 四个状态徽章 |
| 手动 sync 按钮 | 同上 | 点击 POST /sync/run + disabled 当 syncing |
| sync-status store | `stores/sync-status.test.ts` | setStatus + selector |
| events-subscriber 分支 | `components/events-subscriber-core.test.ts`（已有，扩） | sync:status_changed → store 更新 |

### 12.4 e2e（dual profile）

§8.3 D1-D12，`SKYBRIDGE_E2E=1` gated。

### 12.5 手动视觉验收

跑 `just dev-skybridge` 起 server + daemon + GUI；操作：
1. 状态栏出现 "idle"
2. 点 ↻ → 出现 "syncing" → 几百 ms 后回到 "idle"，时间戳更新
3. 另起 profile B daemon（OWL_NEST_DIR 切换），B 创建 note → A 状态栏自动闪烁（SSE 触发），打开任意 folder 看到 B 的 note（手动 Cmd+R 刷新）

## 13. 评审反馈拍板记录

### v1 → v2 决议

| # | 问题 | 决议 |
|---|---|---|
| 1 | conversation `message_id` | **不做**，留 P5-c。P5-b 不做 hash 去重（会误删合法重复 "ok"），跨设备 append 直接整段追加，change 级幂等靠 cid |
| 2 | `local_device_uuid` NOT NULL 实施方式 | **见 v3 #B**：撤回 v2 的表重建方案，改 ADD COLUMN + trigger |
| 3 | SSE 重连退避 | 2/4/8/16/30s + 0-1s jitter，**持续重连永不停**，进入 "offline" 状态但不放弃。彻底放弃留 P5-c |
| 4 | 状态栏位置 | 嵌入现有 status info 同一行右侧，不单独占一行；窄宽度折叠成图标 + popover |
| 5 | 事件命名 | **见 v4 #H**：撤回内部 event 通道方案，scheduler 直接调而非订阅 |

### v2 → v3 决议（blocking 修正）

| # | 问题 | 决议 |
|---|---|---|
| A | folder delete payload 矩阵自相矛盾 | §4.2 矩阵 + §4.2 validator + §4.3 LWW 统一改成 `{ updated_at_ms }`；emit 端 `deleteFolder` 加 `updated_at_ms`（方案 a） |
| B | notes / folders 表重建会 cascade 清 note_tags / reminder_status | 撤回表重建。改 **ADD COLUMN + backfill + BEFORE INSERT/UPDATE trigger 拒绝 NULL**（§3.5）。`device_id` 早就 nullable（schema.ts:15, :33），不需要改。运行时 NOT NULL 靠 trigger，drizzle schema declare `.notNull()` 给 TS 端 type-safe |
| C | SSE 离线场景测不了 | sse-bridge `onOpen` 主动 runManualSync 一次 catch-up（§6.2）。D11 改成"B 离线 → A push → B reconnect 时 catch-up sync 跑"，D11b 新增"B 在线时 SSE onChange 触发"覆盖原 D11 |
| D | `[device].id` module cache 撞双 profile | 撤回 module cache。`registerDevice` 成功时把 skybridge_device_id / workspace_id INSERT OR REPLACE 进**该 profile 的** `local_metadata` 表，mutation 读 SQL（§3.3）。每 profile 一个 sqlite → 天然隔离 |
| E | §3.5 假 schema | 撤回。`notes.device_id` 早就 nullable、`content_hash` nullable、`position` 是 `real`。不需要为这些做迁移 |
| F | `migrations/index.ts` 路径错误 | 改为 `packages/core/src/db/migrate.ts:47` |
| G | §2 / §6 / §8 / §11 / §12 残影 | 全部清扫（v3 完成） |

### v3 → v4 决议（blocking 修正）

| # | 问题 | 决议 |
|---|---|---|
| H | `sync:completed` internal event 和 OwlEvent / GUI `/events` 共用通道 → 泄漏给 GUI | 撤回 internal event。`runManualSync` 成功后**直接调** `ctx.scheduler.reload()`；OwlEvent 只承担外部 `sync:status_changed`（§5.4 / §6.3） |
| I | 0006 trigger 只拦 INSERT 不拦 UPDATE | §3.5 加 `BEFORE UPDATE OF local_device_uuid` trigger（notes + folders 各一个） |
| J | §9.1 残留表重建残影 | 重写 §9.1，明确 ADD COLUMN 路径 + 不重建表 |
| K | `note_alarms` 不是 owl 表 | 全文搜替换为 `reminder_status`（§3.5 cascade 描述 / §9.3 / §15）；owl 仅 `note_tags` + `reminder_status` 通过 `ON DELETE CASCADE REFERENCES notes` |
| L | §3.2 兼容性段写"`notes.device_id` 加列前是 NOT NULL" | 删错描述：早就 nullable（schema.ts:15 / :33）；不需要在 0006 改 constraint |
| M | `skybridge_device_id` 只在 register 成功时写 | 改为**每次** `ensureSkybridgeSession` 拿到最终 `config.device.id` / `workspace.id` 都 INSERT OR REPLACE 写入；不依赖"register 是否真发生"（§6.1） |
| N | `device_id` 旧 local uuid 没拍板 backfill | `ensureSkybridgeSession` 首次（`local_metadata.skybridge_backfilled` 未置位）做非破坏性 `UPDATE WHERE device_id IS NULL OR device_id = local_device_uuid` —— 不覆盖 apply 已写的远端行（§6.1） |
| O | note tag validator 只把 `tag_type` 当 string | §4.2 加 `TAG_TYPES` 枚举 + `assertTagType`，未知 tag_type → SkybridgeProtocolError throw |
| P | §6.2 `import RealSkybridgeClient from './manual.js'` | 改成从 `./session.js` import（session.ts 同时导出 `RealSkybridgeClient` interface，`manual.ts` 也从 session.ts 拿） |
| Q | §1.3 "覆盖 §13 全部 8 步"（§13 已变成拍板记录） | 改成"覆盖 §8.3 D1-D12" |

### v4 → v5 决议（细节收口）

| # | 问题 | 决议 |
|---|---|---|
| R | tag_type 枚举示例假 | §4.2 删硬编码，改 `import { TAG_TYPES, type TagType } from '../../tags/parser.js'` —— owl 实际枚举见 parser.ts:8 (`#` / `/time` / `/alarm` / `/daily` / `/weekly` / `/monthly` / `/yearly`)，未来扩 tag 时不动 doc |
| S | `AppContext` 漏字段 + scheduler 路径 | §10 文件清单加 `context.ts:11`（加 `skybridgeSession` 字段）；scheduler 路径 `packages/daemon/src/scheduler.ts`（不是 `reminders/scheduler.ts`） |
| T | SyncStatus shape 与现有 `/sync/status` 不一致 | §6.3 拍板方案 b：新建 `SyncStatusSnapshot`（snake_case，扩展自 `SyncStatusResult` 加 `state` + `last_error`），SSE 发它；`/sync/status` 保留原 shape；GUI 首屏 fetch + adapter |
| U | §1.3 / §3.5 / §6.1 残留旧措辞 | 全部清扫 |

### v5 决议表后的"五个拍板点"

| 项 | 结论 |
|---|---|
| conversation 不做 hash 去重，`message_id` 留 P5-c | ✅ |
| `local_device_uuid` 用 ADD COLUMN + trigger（INSERT + UPDATE 双 trigger） | ✅ |
| SSE 退避 2/4/8/16/30s + jitter，持续重连永不停 | ✅ |
| SyncStatusBar 嵌入编辑器底部 status 同一行右侧 + container query 折叠 | ✅ |
| 外部 SSE 只用 `sync:status_changed`，无 `sync:completed`/`sync:applied`；scheduler reload 由 manual.ts 直接调 | ✅ |

### 仍可讨论

- `appliedTotal > 0` 守门 `scheduler.reload()` —— 保守版每次成功都 reload；commit 实施时拍板
- ADD COLUMN approach 下，`drizzle schema .notNull()` 与 SQL 端"trigger 兜底"的失配会不会让 select 类型断言遇到 null？理论不会（trigger 拦下任何 NULL INSERT/UPDATE），但 backfill 时若 `local_metadata.device_uuid` 行碰巧不存在（migration 跑在 ensureDeviceId 之前的边缘 case），§3.5 step 1 的 INSERT OR IGNORE 已兜底

## 14. 文档统一

完工时改：

| 文件 | 改动要点 |
|---|---|
| `aviary/docs/ROADMAP.md` | 把 P5-b 标 shipped；P5-c scope 明确 = 后台触发 + retry + conflict_record + 真实双机 |
| `aviary/docs/SKYBRIDGE_ARCH.md` | Phase 4 拆 P5-a/b/c 状态更新 |
| `owl/PROCESS.md` | 「下一步」改成 P5-c；P5-b 进 history 段 |
| `owl/CLAUDE.md` | "skybridge 调试" 章节加 sse-bridge 启停说明 |
| `owl/docs/history/P5-b-shipped.md` | 完工时新建 |
| `skybridge/PROCESS.md` | 下一段 = 等 owl P5-c 决定要不要 server 端 retry / rate limit 调整 |

## 15. 风险与回退

| 风险 | 触发 | 应对 |
|---|---|---|
| device_id 列改造 break 现有 mutation | Step 2 把 emit 改 + 新加 `local_device_uuid`，单元测试覆盖率不全 | Step 2 commit 前 `just check` + 全部 core 测试必须绿；rollback `git revert` |
| 0006 ADD COLUMN trigger 漏拦某个 INSERT 路径 | mutation 没把 `local_device_uuid` 传给 INSERT，依赖 trigger 抓 | §9.3 显式测试 trigger 触发；mutation 单测对所有 INSERT 路径断言 row 的 `local_device_uuid` 非 NULL |
| `note_tags` / `reminder_status` 被 cascade 清空 | （v2 历史问题）表重建会触发 ON DELETE CASCADE | **v3 撤回表重建**，§3.5 用 ADD COLUMN；§9.3 加显式回归断言"行数不变" |
| folder sparse update 误清字段 | apply 端动态 SET 拼 SQL 时漏掉某字段判断 | §4.4 显式列动态 SET 算法；payload validator 单测覆盖各 sparse 组合 |
| conversation 跨设备 append 重复落库 | A 写 ok / B 写 ok / 互相 pull → 两侧各看到 2 条 ok | 已知差异，§4.6 说明；P5-c 引入 message_id 才解决 |
| `syncNoteTags` 抽离后被 daemon 直接 import（绕过 core mutation contract） | grep 守卫 `check-core-convergence.sh` 是否抓 import？ | 守卫只扫 `db.{insert,update,delete}` / `INSERT INTO foo`，不抓 import；Step 4 时人手 review 一次新 export 没被 daemon 误用 |
| SSE 断连 + 后端重发 → daemon 触发风暴 | 短时间内多次 onChange → runManualSync coalescer 已合并 | F3 coalescer 已 ship；SSE 多次 onChange 在 inflight 期间合并成单 follow-up |
| sse-bridge 启动失败让 daemon 拒启动 | bridge.start() throw 没接 | start 内部 try/catch，error 进 logger，daemon 继续启动 |
| `ensureSkybridgeSession` 在没 toml 的纯测试环境 startup throw | session.ts 假设 toml 存在 | startup 时若 `SKYBRIDGE_*` 错误码（toml 缺 / device 没注册）→ logger.warn + sse-bridge 不启动；manual sync 仍能在首次调用时再 ensure |
| GUI SyncStatusBar SSE consumer 内存泄漏 | 组件 unmount 时没解绑 | useEffect cleanup 手动 unsubscribe；EventsSubscriber 接口已支持 |
| dual e2e 测试在不同 OS 时序不一致 | macOS / Linux SSE roundtrip 时间差 | D11 用事件回调断言（"100ms 内 runManualSync 触发"），不是 setTimeout 等 |
| schema v6 触发 GUI MigrationDialog (P3.2-b) | 用户重启 GUI 后弹窗 | 已是预期行为；P5-b 不发版，dev 环境用户接受 |

## 16. 一句话总结

P5-b = **把 P5-a 的"能 sync 但不实用"补全到"能跨设备生活"**：tags / FTS / reminder / folder / conversation 五大补丁 + SSE 实时触发 + GUI 状态栏 + 自动化双 profile 测试。完工时不发版，0.5.0 继续等 P5-c（后台 + retry + conflict + 真实双机）。
