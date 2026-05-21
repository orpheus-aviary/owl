# P5-a — skybridge sync engine 接入（最小 note apply + 手动单机闭环）

日期：2026-05-21
状态：**design** — 待动工
对应里程碑：跨仓 SKYBRIDGE_ARCH Phase 4 的最小可验证子集

> 设计 review 历史：
> - v1 因（a）目标与 §7.3 互相矛盾、（b）把未发布包当 committed dep、（c）core 引入 skybridge 类型、（d）response helper / 端口 / 错误码错位等问题作废
> - v2 因（a）payload validator 字段名与真实 Owl 模型不一致、（b）delete/pin/reorder emit 缺 `updated_at_ms`、（c）pin/reorder 不动 `notes.updated_at` 致 LWW 公式失效、（d）profile B 隔离机制仍是 open question、（e）ServerChange 字段名笔误、（f）`@owl/core` 子路径导出不存在等问题作废
>
> - v3 因（a）字面量 dynamic import specifier 让 tsc 在干净 checkout 上仍试图解析 `@skybridge/*`、（b）daemon 集成测无 gating、干净 checkout 跑 `just test` 会因缺 server 包炸、（c）`skybridge-sync-once.sh` 硬编码 nest dir、双 profile 测试串库、（d）测试矩阵残留 emit-端 validator 用例、（e）apply 路径漏写 `content_hash` 列等问题增量修订
>
> - v4 因（a）runSync 是 pull→push 顺序但 §13.3 错按 push→pull 写期望、（b）多 batch pull 没显式推进内存 cursor、缺少 `empty batch + hasMore` 协议守卫、（c）daemon/core 实际用 `node:test` 不是 vitest（package.json:13），所有 vitest 假设需要重写为 node:test pattern、（d）apply 路径 missing-local-note 时 SQL `changes=0` 但 pseudocode 仍返回 `applied`、（e）tags apply 不同步 FTS / 实际未在 P5-a 实现、（f）`skybridge-sync-once.sh` 在 owl root 找不到 smol-toml 等问题增量修订
>
> - v5 残留：core 单测 runner 文案误写 vitest、§13.1 step 1 残留 "vitest exclude"、`sync_cursor` 写入没说明 upsert（首次 push 会撞 UPDATE 0 行 + 后续 INSERT 撞 PK）、§16 留了一条已被 §7.5 解决的 `applyTagsForNote` open question。
>
> 本文是 v6 修订版。开工锁定版本。

## 1. 背景与目标

skybridge Phase 3 收尾（2026-05-12），三 package（proto / server / client）齐备，78/78 测试，本地 git tag `@skybridge/{server,client}@0.1.0`，**未 npm publish、未 push tag**。owl 端 P4 Phase 1+2 已 ship，schema v4 落库，14 个 mutation 路径在事务内向 `sync_changes` emit。

P5-a 目标 — 验证**最小同步闭环**：

```
owl A（设备 A 的 profile）          skybridge server          owl B（设备 B 的 profile，同机另一个 nest dir）
    │                                       │                       │
    │  POST /sync/run                       │                       │
    │  → push 1 条 note create ─────────────▶                       │
    │  ◀──────────────────── ack(server_seq)│                       │
    │                                       │                       │
    │                                       │ ◀── POST /sync/run    │
    │                                       │ pullChanges(cursor=0) │
    │                                       │ ────────────────────▶ │
    │                                       │                       │
    │                                       │              apply 到 B.owl.db notes 表
    │                                       │              cursor 推进
```

**最小闭环要证明**：
- HTTP 通道 + auth + workspace 注册全部通
- outbox 状态机（cid / synced_at / server_seq）端到端正确
- pull→apply→cursor 推进的事务语义正确
- 一类 entity（note）的双设备语义在单机两 profile 下收敛

P5-a **不**做 SSE 订阅、不做后台定时、不做网络恢复触发、不做 GUI 同步状态栏、不做冲突 UI、不做真实双机/远程 server。这些是 P5-b / P5-c / P6。

发版时机：等 owl + lark + jay 完整后再决定 0.5.x / 1.0.0 切线。skybridge `npm publish` / push tag 也推迟到那时。详见 `aviary/docs/ROADMAP.md`（同期更新）。

## 2. 范围（硬钉）

### In — P5-a 必做

- **skybridge 仓**：本地 pack 工作流（3 个 tarball + `bundledDependencies`）、生产 tsconfig 拆分、`just pack-*` recipes
- **owl 仓**：
  - **Step 0a — `OWL_NEST_DIR` env override**：`packages/core/src/config/paths.ts` 加 env 解析，让 daemon 在不同 nest dir 下并行运行（手动验收 profile B 隔离的先决条件）
  - **Step 0b — delete emit 补 `updated_at_ms`**：`packages/core/src/notes/index.ts` 的 `permanentDeleteNote` 当前 emit `payload: {}`，必须改成 `{ updated_at_ms: nowMs }`；`batchPermanentDeleteNotes` 同理
  - schema v5：`sync_changes` 加 `client_change_id` / `server_seq` / `synced_at` + cid UNIQUE 索引
  - `emitSyncChange` 返回 cid（**不**在 emit 端跑 payload validator —— 见 §6.3 解释）
  - `packages/core/src/sync/payloads/note.ts`：note 5 个 content op 的 apply-side payload runtime validator（pin / reorder 不在内）
  - `packages/core/src/sync/engine.ts`：`runSync(deps)`，**结构化接口**注入 skybridge client，core 零 skybridge 依赖
  - `packages/core/src/skybridge/config.ts`：`skybridge_config.toml` 读写
  - daemon `routes/sync.ts`（`run` / `status` / `login`）+ adapter（dynamic import `@skybridge/client`，无 top-level 类型依赖）
  - daemon 集成测：dynamic import `@skybridge/server` 起 in-process server
  - CLI `commands/sync.ts`（`run` / `status` / `login` / `config show`），全部走 daemon HTTP，**零 skybridge 依赖**
  - just recipes：`skybridge-install` / `skybridge-uninstall` / `skybridge-server` / `skybridge-sync-once` / `dev-skybridge`
  - 守卫：`scripts/check-skybridge-not-committed.sh` 进 `just check`
- **手动验收清单**（§13）— 单机双 profile 必须跑通

### Out — 留给 P5-b / P5-c / P6

- **P5-b**：folder / conversation / tag / reminder 等其它 entity 的 payload schema 冻结与 apply；`@skybridge/client` SSE 订阅 → daemon → GUI；同步状态栏；GUI 手动 sync 按钮；**自动化双 client 集成测试**（同进程双 owl profile）
- **P5-c**：后台定时 / 网络恢复触发 / 429 / 5xx 重试策略 / `conflict_record` 写入语义 / 真实双机 + 远程 server soak
- **P6**：多设备 GA / 冲突 UI / attachment 通道

### 永不做

- CRDT / OT / P2P / 自动 merge

## 3. P5-a 范围内的 note apply 语义（硬钉）

### 3.1 entity / op 矩阵

P5-a apply **只覆盖** `entity_type = 'note'` 的 5 个 **content op**。pin / reorder 是 **metadata op**，不参与 apply。

| entity | op | emit & push | apply (pull→local) |
|---|---|---|---|
| note | `create` | ✓（已有 `updated_at_ms`） | ✓ upsert，LWW |
| note | `update` | ✓（已有 `updated_at_ms`；sparse fields） | ✓ partial update，LWW |
| note | `trash` | ✓（已有 `updated_at_ms` + `trash_level`/`trashed_at_ms`/`auto_delete_at_ms`） | ✓ 写 `trash_level`/`trashed_at`/`auto_delete_at`，LWW |
| note | `restore` | ✓（同上） | ✓ 反向，LWW |
| note | `delete` | Step 0b 修复后 ✓（emit 补 `updated_at_ms`） | ✓ 物理删除，LWW |
| note | `pin` | ✓（payload = `{ pinned_at_ms }`，**无** `updated_at_ms`，因 setNotePinned 不动 `notes.updated_at`） | **skip** + log + cursor 推进 |
| note | op=`update` reorder 路径 | ✓（payload = `{ position }`，**无** `updated_at_ms`，reorder 不动 `notes.updated_at`） | **skip** + log + cursor 推进 |
| folder / conversation / 其它 | — | 既有 emit 继续 | **skip** + log + cursor 推进 |

**判定规则**：apply 端拉到 ServerChange 后，
1. `entity_type !== 'note'` → skip + log + 推进 cursor
2. `entity_type === 'note'` 且 `payload.updated_at_ms` 不存在 → 视为 metadata op（pin / reorder） → skip + log + 推进 cursor
3. `entity_type === 'note'` 且 `payload.updated_at_ms` 存在 → 跑 `parseNotePayload(op, payload)`，失败抛 → 整 batch 回滚、cursor 不前进
4. validator 通过 → 走 LWW（§3.2）

注意 §3 把 "判定 metadata op 是否 skip" 的依据从 `op` 字符串改为 **payload 是否有 `updated_at_ms`**。这样 reorder（op 仍叫 `update`、但 payload 只有 position）能被正确归类，不会被误当成 content update 又找不到 validator 需要的字段而炸。

### 3.2 LWW 公式（仅适用于 5 个 content op）

```
remote_ts = payload.updated_at_ms       (validator 已保证存在)
local_ts  = SELECT updated_at FROM notes WHERE id = entity_id   (本地不存在视为 0)

apply 条件：
  - 自己 device 出的 cid 已存在本地 sync_changes 且 synced_at IS NOT NULL  → skip（self-replay 防回环）
  - op = 'create' 且本地不存在该 note (local_ts = 0)                       → apply（INSERT）
  - op = 'delete' 且 local_ts > remote_ts                                  → skip + log "deferred"
  - op != 'delete' 且 local_ts >= remote_ts                                → skip（tie 也跳过）
  - 否则                                                                    → apply
```

注意：
- **tie 不覆盖** — 用 `>=` 而非 `>`
- P5-a 不写 `conflict_record`；任何 skip 路径只 log
- self-device dedup 用 cid 命中本地已 synced 行，不是用 device_id —— 后者会误杀第二台设备 echo 回来的真冲突
- create 与 update 的 apply SQL 是同一段 upsert（INSERT ... ON CONFLICT(id) DO UPDATE），LWW 守门在 SQL 之前的 JS 判定层

### 3.3 payload validator（apply-side only）

`packages/core/src/sync/payloads/note.ts` —— 字段名严格对齐真实 emit 形态（`packages/core/src/notes/index.ts:145/389/465/521/546`）。

```ts
// 5 个 content op 的 payload narrow。手写，不引 zod。
// pin / reorder 的 payload 不在此 validator 范围（apply 端 §3.1 规则 2 提前 skip）。

export interface NoteTag {
  tag_type: string;
  tag_value: string | null;
}

export interface NoteCreatePayload {
  content: string;
  folder_id: string | null;
  trash_level: number;
  created_at_ms: number;
  updated_at_ms: number;
  tags: NoteTag[];
}

export interface NoteUpdatePayload {
  // sparse post-state — emit 只放被修改的字段，validator 只验出现字段类型
  updated_at_ms: number;
  content?: string;
  folder_id?: string | null;
  tags?: NoteTag[];
}

export interface NoteTrashPayload {
  updated_at_ms: number;
  trash_level: number;
  trashed_at_ms: number;
  auto_delete_at_ms: number | null;
}

export interface NoteRestorePayload {
  updated_at_ms: number;
  trash_level: number;
  trashed_at_ms: number | null;
  auto_delete_at_ms: null;       // restore 总是清零
}

export interface NoteDeletePayload {
  updated_at_ms: number;         // Step 0b 修复后保证存在
}

export type NoteApplyPayload =
  | { op: 'create';  body: NoteCreatePayload }
  | { op: 'update';  body: NoteUpdatePayload }
  | { op: 'trash';   body: NoteTrashPayload }
  | { op: 'restore'; body: NoteRestorePayload }
  | { op: 'delete';  body: NoteDeletePayload };

export class NotePayloadInvalidError extends Error {
  constructor(public readonly reason: string, public readonly raw: unknown) {
    super(`note payload invalid: ${reason}`);
  }
}

/** Narrow & validate. Caller must already have screened out pin / reorder
 *  via the §3.1 rule (entity_type === 'note' && payload.updated_at_ms exists). */
export function parseNotePayload(op: string, raw: unknown): NoteApplyPayload { ... }
```

**validator 只在 apply 端跑**。emit 端 **不** 调 validator，因为：
- pin / reorder 的 payload 在 emit 端不带 `updated_at_ms`（这是 P4 Phase 2 既定行为，setNotePinned/reorderNotesInFolder 不动 `notes.updated_at`），跑 validator 会误报
- emit 是 owl 自家代码，类型已经在 mutation 函数里收紧；apply 才是收外部数据需要防御性校验的边界
- 避免 emit 期间额外开销

validator 失败 → `runSync` 整个 pull batch 事务回滚、cursor 不前进，错误向上抛。

## 4. 跨仓架构

```
┌──── ~/orpheus-aviary-nest/ ──────────────────────────────────────────┐
│  owl/owl.db (schema v5)        skybridge/skybridge_config.toml       │
│   ├ sync_changes (+3 cols)      ├ [server] url                       │
│   ├ sync_cursor                 ├ [auth] user_id / token / email     │
│   └ conflict_record (空)        ├ [device] id / name                 │
│                                 └ [workspace] id / slug              │
└──────────────────────────────────────────────────────────────────────┘

  ┌────────── owl 仓 ──────────┐                  ┌── skybridge 仓 ──┐
  │ daemon (port 47010 默认)   │                  │ server (local)   │
  │ ├ POST /sync/run ──────────┼──── HTTP ───────▶│ /v1/changes/*    │
  │ │   └ runSync(deps)        │                  │ /v1/workspaces/* │
  │ ├ POST /sync/login         │                  │ /v1/auth/*       │
  │ ├ GET  /sync/status        │                  │ /v1/devices/*    │
  │ │   └ dynamic import       │                  │                  │
  │ │     @skybridge/client    │                  │ better-sqlite3   │
  │ │                          │                  └──────────────────┘
  │ cli: owl sync run ─────────┘
  │   (走 daemon HTTP，零 skybridge 依赖)
  └────────────────────────────┘
```

调用链：
1. owl daemon 启动时尝试读 `skybridge_config.toml`；缺失或不完整 → log "skybridge: disabled"，daemon 其它功能不受影响
2. `owl sync login` → `POST /sync/login` → daemon 调 `@skybridge/client` 的 `login` 原语 → 写 toml
3. `owl sync run` → `POST /sync/run` → daemon 组装 client（按需 register device / ensure workspace）→ `runSync(deps)` → 5 原语 push/pull
4. client → HTTP → 本地 skybridge server（默认 `127.0.0.1:18443`，由 toml 决定）
5. server 读写 `~/orpheus-aviary-nest/skybridge/skybridge.db`

## 5. skybridge_config.toml 持久化

### 5.1 路径与所有权

- 位置：`~/orpheus-aviary-nest/skybridge/skybridge_config.toml`（**与 skybridge server 自己的 server.toml 不是同一个文件**：server.toml 在 skybridge 仓工作目录下管 server 自身端口/db_path/log；本文件归 owl daemon 读写，存的是**客户端**连接配置）
- 创建：`POST /sync/login` 第一次成功时写入；不在 daemon 启动时主动创建
- 读：`packages/core/src/skybridge/config.ts` 提供 `readConfig() / writeConfig() / configPath()`。daemon 每次进入 sync route 时重读（不缓存超过单次请求），简单胜过精巧
- 写：`registerDevice` / `ensureWorkspace` / `login` 成功后整体重写 toml；不做增量 patch，避免并发问题
- 权限：`chmod 600`（macOS / Linux）

### 5.2 TOML schema

```toml
# ~/orpheus-aviary-nest/skybridge/skybridge_config.toml

[server]
url = "http://127.0.0.1:18443"

[auth]
# skybridge AuthContext 不含 expiry —— owl 不主动合成 expires_at。
# 失效检测靠 runtime：API 返回 401 → 删 [auth] 段、报 SKYBRIDGE_AUTH_REQUIRED。
user_id = "usr_..."
token   = "tok_..."
email   = "jay@local"   # 仅供 `owl sync config show` 展示

[device]
id             = "dev_..."
name           = "Jay's MacBook (owl)"
app_version    = "owl 0.5.0-dev"
client_version = "0.1.0"

[workspace]
id   = "ws_..."
slug = "owl/default"
```

`sync_cursor` **不**写入 toml — 它走 `owl.db.sync_cursor` 表（schema v4 已落地），key 用 `[server].url`，方便 reset 时不需要碰文件。

### 5.3 凭证管理

P5-a token 明文存 toml + `chmod 600`，display warning。系统 keychain 集成挪到 P5-c 或独立 phase。

### 5.4 错误语义

| 状况 | error_code | 处理 |
|---|---|---|
| 文件缺失 | `SKYBRIDGE_NOT_CONFIGURED` | 告知用户运行 `owl sync login` |
| `[server].url` 缺失 | `SKYBRIDGE_SERVER_URL_MISSING` | 同上 |
| `[auth]` 缺失 | `SKYBRIDGE_AUTH_REQUIRED` | 跑 `owl sync login` |
| API 返回 401（token 失效 / 被撤销） | `SKYBRIDGE_AUTH_REQUIRED` | sync route 删除 toml `[auth]` 段，告诉用户重新 login |
| `[device]` 缺失 | — | 自动 `registerDevice`，结果回写 |
| `[workspace]` 缺失 | — | 自动 `ensureWorkspace("owl", "default")`，结果回写 |
| 网络错（client 抛 `NetworkError`） | `SKYBRIDGE_SERVER_UNREACHABLE` | 用户检查 server |
| API 错（其它 4xx/5xx，client 抛 `ApiError`） | `SKYBRIDGE_API_ERROR` | 透传 status + message |
| 其它 | `SKYBRIDGE_SYNC_FAILED` | log + 返回错 |

## 6. owl schema v5

### 6.1 动机

`sync_changes` 当前列（v4）：`local_seq` / `device_id` / `entity_type` / `entity_id` / `op` / `payload` / `created_at`。push 流程额外需要：

- `client_change_id`（per-row UUID）— 服务端用它去重 (`accepted` vs `duplicates`)。崩溃 + 重放必须给同一行同样的 cid，否则 server 看不出是同一笔
- `server_seq`（push 成功后回填）
- `synced_at`（区分已确认 / 未确认；过滤 pending push 集合）

不能复用 `sync_cursor.pushed_seq` 当 watermark：server 接受是逐条返回 cid → server_seq 的，可能部分成功部分失败，必须 per-row 标记。

### 6.2 Migration `0005_sync_change_outbox.sql`

```sql
-- 0005_sync_change_outbox.sql — sync_changes 行加 outbox 状态列（user_version = 5）
--
-- INVARIANT: 一旦 ship 本文件不可改。后续走 0006_*.sql。
--
-- 动机：P5-a sync engine 需要 per-row clientChangeId / server_seq / synced_at
-- 来支撑 push 确认与重放语义。schema v4 的 sync_changes 只够 emit，不够 push。

ALTER TABLE sync_changes ADD COLUMN client_change_id TEXT;
ALTER TABLE sync_changes ADD COLUMN server_seq        INTEGER;
ALTER TABLE sync_changes ADD COLUMN synced_at         INTEGER;

-- 回填已存在的 v4 行（P4 Phase 2 累积的、尚未 push 过的本地变更）。
UPDATE sync_changes
SET client_change_id = lower(hex(randomblob(16)))
WHERE client_change_id IS NULL;

-- v4 时代 delete emit 的 payload 是 `{}`，缺 `updated_at_ms`。Step 0b 之后新行 OK，
-- 但 v4 库里堆积的旧 delete 行需要 backfill：用 created_at 当 fallback。
-- 这样首次 push 上去的 delete change 不会因为 server / 对端 apply 验证缺字段而崩。
UPDATE sync_changes
SET payload = json_object('updated_at_ms', created_at)
WHERE entity_type = 'note'
  AND op = 'delete'
  AND payload = '{}';

-- cid 唯一性：应用层 emit 时用 randomUUID()，碰撞概率忽略；UNIQUE 保证
-- "按 cid 回填 server_seq" 的 UPDATE 永远只命中一行（防御性）。
CREATE UNIQUE INDEX idx_sync_changes_cid ON sync_changes(client_change_id);

-- 加速 "找出所有 pending push" 的查询。
CREATE INDEX idx_sync_changes_pending
  ON sync_changes(synced_at)
  WHERE synced_at IS NULL;
```

`LATEST_KNOWN_VERSION` 升到 `5`。CLI publish 脚本已支持自动 copy 所有 `NNNN_*.sql`（0.4.0 hotfix 修过）。

### 6.3 `emitSyncChange` 改造

```ts
// packages/core/src/sync/changes.ts
export function emitSyncChange(sqlite: Database.Database, args: EmitSyncChangeArgs): string {
  const deviceId       = readOrInitDeviceId(sqlite);
  const clientChangeId = randomUUID();
  const createdAt      = args.nowMs ?? Date.now();

  sqlite.prepare(`
    INSERT INTO sync_changes
      (device_id, entity_type, entity_id, op, payload, created_at, client_change_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    deviceId, args.entityType, args.entityId, args.op,
    JSON.stringify(args.payload), createdAt, clientChangeId,
  );
  return clientChangeId;
}
```

**不**在 emit 端跑 `parseNotePayload`，原因见 §3.3：emit 是自家代码、类型已经在 mutation 函数里收紧；pin / reorder 不带 `updated_at_ms` 是设计本意，跑 validator 会误报。validator 只在 apply 边界跑。

返回值新增（cid），所有 14 个现有调用点保持不变（不需要 cid）。

### 6.4 现有 emit payload 形态确认 + Step 0b 修复点

逐条核对（参照 `packages/core/src/notes/index.ts`）：

| op | 行号 | payload 字段 | 是否需要改 |
|---|---|---|---|
| `create` | :145 | `content`, `folder_id`, `trash_level`, `created_at_ms`, `updated_at_ms`, `tags[]` | 不动 ✓ |
| `update` | :389-395 | `updated_at_ms` + 任意子集 `content` / `folder_id` / `tags` | 不动 ✓ |
| `trash` | :461-475 | `trash_level`, `trashed_at_ms`, `auto_delete_at_ms`, `updated_at_ms` | 不动 ✓ |
| `restore` | :517-531 | `trash_level`, `trashed_at_ms`, `auto_delete_at_ms`, `updated_at_ms` | 不动 ✓ |
| `delete` | :546-552 | `{}` | **改**：加 `updated_at_ms: nowMs`（Step 0b） |
| `pin` | :675-682 | `pinned_at_ms` | 不动（apply 端 skip） |
| `update` reorder | :750-758 | `position` | 不动（apply 端 skip） |

**Step 0b 实施**：`permanentDeleteNote` 和 `batchPermanentDeleteNotes` 的 emit 处加 `updated_at_ms: Date.now()`。`batchPermanentDeleteNotes` 调用 `permanentDeleteNote`，改一个位置就够；单测要补一项 "delete emit payload 含 `updated_at_ms`"。

Step 0a + 0b 都是 P5-a 必要前置条件，**不**留在 open question。详见 §14 commit 顺序。

## 7. core `runSync()` 设计

### 7.1 结构化接口（core 零 skybridge 依赖）

```ts
// packages/core/src/sync/engine.ts —— 不 import 任何 @skybridge/* 包

export interface LocalChangeLike {
  clientChangeId: string;
  entityType: string;
  entityId: string;
  op: string;
  payload: unknown;
  clientLocalSeq: number;
  clientCreatedAt: number;
  attachmentRefs: null;
}

/** Minimal subset of @skybridge/proto ServerChange that runSync actually reads.
 *  serverReceivedAt / clientLocalSeq / clientCreatedAt / attachmentRefs are
 *  intentionally dropped — daemon adapter forwards only what's needed. */
export interface ServerChangeLike {
  serverSeq: number;
  clientChangeId: string;
  deviceId: string;       // 仅用于 log，不参与 dedup 判断（dedup 用 cid）
  entityType: string;
  entityId: string;
  op: string;
  payload: unknown;
}

export interface PushAckLike {
  clientChangeId: string;
  serverSeq: number;
}

export interface PushResultLike {
  accepted: PushAckLike[];
  duplicates: PushAckLike[];
}

export interface PullResultLike {
  changes: ServerChangeLike[];
  hasMore: boolean;
}

/** Structural subset of @skybridge/client SkybridgeClient. */
export interface SkybridgeClientLike {
  pullChanges(workspaceId: string, sinceServerSeq: number): Promise<PullResultLike>;
  pushChanges(workspaceId: string, changes: LocalChangeLike[]): Promise<PushResultLike>;
}

export interface RunSyncDeps {
  sqlite: Database.Database;
  client: SkybridgeClientLike;
  workspaceId: string;
  serverUrl: string;   // sync_cursor.endpoint key
  nowMs?: () => number;
  logger?: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
}

export interface RunSyncResult {
  pulledTotal: number;
  appliedTotal: number;
  skippedTotal: number;     // self-replay / LWW-loser / non-note
  pushedTotal: number;
  duplicatesTotal: number;
  serverSeqHigh: number;
  cursorBefore: number;
  cursorAfter: number;
}

export async function runSync(deps: RunSyncDeps): Promise<RunSyncResult> { ... }
```

daemon 写一层 thin adapter（`packages/daemon/src/sync/adapter.ts`）把真实 `SkybridgeClient` 包成 `SkybridgeClientLike`，shape 几乎相同，只是断绝 core 的 import 链。

### 7.2 流程

**Step 1: pull**
1. 读 `sync_cursor.pulled_seq` for `serverUrl`（缺失 = 0）—— 记 `cursorBefore`，并把 `cursor` 初始化为它（**内存变量**，循环间累积推进）
2. 循环：`client.pullChanges(workspaceId, cursor)` 直到 `hasMore === false`
3. 每个 batch 在**单事务**里，对每个 `ServerChangeLike` 按 §3.1 判定链：
   - 若 `entityType !== 'note'` → log + `skippedTotal++`，不调 validator、不 apply
   - 若 `entityType === 'note'` 但 payload 缺 `updated_at_ms` → 视为 metadata op (pin / reorder) → log + `skippedTotal++`，不调 validator、不 apply
   - 否则调 `parseNotePayload(op, payload)` —— 失败 throw，整 batch 回滚，cursor 不前进
   - validator 通过 → `applyNoteChange` 走 §3.2 LWW → `appliedTotal++` 或 `skippedTotal++`
   - 处理完该 batch 全部条目后：
     - **更新内存 `cursor = max(cursor, batch_changes.map(c => c.serverSeq))`**（必须 commit 前算好；下一次 `pullChanges(cursor)` 用它）
     - 把同样的 `cursor` 写入 DB `sync_cursor`（**upsert**，见 §7.6）
4. **协议守卫**：若 `pulled.changes.length === 0 && pulled.hasMore === true` → 抛 `SkybridgeProtocolError('empty batch with hasMore=true')`，避免死循环。skybridge server 当前实现不应回这种 response，但客户端兜底
5. 异常：整 batch 回滚；返回错误给 caller；DB cursor 不前进；内存 cursor 状态随函数返回丢弃

**Step 2: push**
1. `SELECT * FROM sync_changes WHERE synced_at IS NULL ORDER BY local_seq` → pending
2. 若空 → 跳过
3. 映射为 `LocalChangeLike[]`：
   ```
   { clientChangeId, entityType, entityId, op,
     payload: JSON.parse(payload),
     clientLocalSeq: local_seq, clientCreatedAt: created_at,
     attachmentRefs: null }
   ```
4. `client.pushChanges(workspaceId, changes)` → `{ accepted, duplicates }`
5. **事务内**回填：每个 ack 走
   `UPDATE sync_changes SET server_seq = ?, synced_at = ? WHERE client_change_id = ?`
6. `sync_cursor.pushed_seq = max(server_seq)`（信息性；**upsert**，见 §7.6）

**Step 3** 组装 `RunSyncResult` 返回。

### 7.3 self-replay 防回环

push 上去的 change 服务端会 echo 回 pull stream（B 设备的 pull 会包含 A 推上去的，反之亦然）。但对**同一设备**自己 push 自己 pull 的情况：

```
sync 1: A push n1 → ack(server_seq=5) → sync_changes.synced_at 写入
sync 2: A pull from cursor=0 → 拉回包括 n1 的 ServerChange
        → apply 时检查：n1.cid 已在本地 sync_changes 且 synced_at IS NOT NULL → skip
        → cursor 推进到 5
```

实现：apply 前 `SELECT 1 FROM sync_changes WHERE client_change_id = ? AND synced_at IS NOT NULL`，命中即跳过。

### 7.4 LWW 在 SQL 层的实现

apply note 5 个 content op 不走现有 core 写函数（那会再 emit 一行 sync_changes，污染 outbox）。直接执行 raw SQL：

```ts
import type { NoteApplyPayload } from './payloads/note.js';
import { contentHash } from '../notes/hash.js';   // 复用既有派生函数（notes/hash.ts:4）

function applyNoteChange(
  sqlite: Database.Database,
  c: ServerChangeLike,
  payload: NoteApplyPayload,
): 'applied' | 'skipped' {
  // self-replay 防回环：本地 sync_changes 已有此 cid 且已 synced → 本地就是源头
  const ownRow = sqlite
    .prepare('SELECT 1 FROM sync_changes WHERE client_change_id = ? AND synced_at IS NOT NULL')
    .get(c.clientChangeId);
  if (ownRow) return 'skipped';

  const local = sqlite
    .prepare('SELECT updated_at FROM notes WHERE id = ?')
    .get(c.entityId) as { updated_at: number } | undefined;
  const localTs = local?.updated_at ?? 0;
  const remoteTs = payload.body.updated_at_ms;

  // 本地不存在该 note —— 三种 op 的处理：
  //  - create: 走下面 case 'create' 的 INSERT 路径
  //  - update/trash/restore: skip + log（缺乏前置 create，乱序到达 / out-of-order pull；P5-a
  //    不补 create，等下一轮 pull 把它带过来）
  //  - delete: idempotent skip（本地本来就没有，等于已删）
  if (!local) {
    if (payload.op === 'create') {
      // 落到下面的 INSERT 分支
    } else {
      return 'skipped';
    }
  }

  // delete 特例（本地存在）
  if (payload.op === 'delete') {
    if (localTs > remoteTs) return 'skipped';   // 本地更新更晚，跳过 + log
    const result = sqlite.prepare('DELETE FROM notes WHERE id = ?').run(c.entityId);
    return result.changes > 0 ? 'applied' : 'skipped';
  }

  // 其它三种 op (update/trash/restore，本地存在)：LWW 守门
  if (localTs >= remoteTs) return 'skipped';

  switch (payload.op) {
    case 'create': {
      const b = payload.body;
      const hash = contentHash(b.content);
      // UPSERT —— 双设备并行 create 同一 id 极小概率，但 LWW 仍然守门。
      // content_hash 与 device_id 都由 apply 端派生（remote payload 不带，见 notes/index.ts:387 注释）：
      //  - content_hash: contentHash(content)
      //  - device_id:    ServerChange.deviceId（标记来源设备）
      sqlite.prepare(`
        INSERT INTO notes (id, folder_id, trash_level, created_at, updated_at, content, content_hash, device_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          folder_id    = excluded.folder_id,
          trash_level  = excluded.trash_level,
          updated_at   = excluded.updated_at,
          content      = excluded.content,
          content_hash = excluded.content_hash,
          device_id    = excluded.device_id
      `).run(c.entityId, b.folder_id, b.trash_level, b.created_at_ms, b.updated_at_ms, b.content, hash, c.deviceId);
      // P5-a: tags 关系 apply **不**执行（见 §7.5）
      break;
    }
    case 'update': {
      // sparse: 只更新出现的字段；updated_at_ms 总在
      const b = payload.body;
      const sets: string[] = ['updated_at = ?', 'device_id = ?'];
      const vals: unknown[] = [b.updated_at_ms, c.deviceId];
      if (b.content !== undefined) {
        sets.push('content = ?');       vals.push(b.content);
        sets.push('content_hash = ?');  vals.push(contentHash(b.content));   // 与 content 同步派生
      }
      if (b.folder_id !== undefined) { sets.push('folder_id = ?');  vals.push(b.folder_id); }
      vals.push(c.entityId);
      const r = sqlite.prepare(`UPDATE notes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      if (r.changes === 0) return 'skipped';
      // P5-a: tags 关系 apply 在 P5-b 实现（需要同时维护 note_tags + notes_fts.tags_text，见 §7.5）
      break;
    }
    case 'trash':
    case 'restore': {
      const b = payload.body;
      const r = sqlite.prepare(`
        UPDATE notes
        SET trash_level     = ?,
            trashed_at      = ?,
            auto_delete_at  = ?,
            updated_at      = ?,
            device_id       = ?
        WHERE id = ?
      `).run(b.trash_level, b.trashed_at_ms, b.auto_delete_at_ms ?? null, b.updated_at_ms, c.deviceId, c.entityId);
      if (r.changes === 0) return 'skipped';
      break;
    }
  }
  return 'applied';
}

```

注意：
- `notes.updated_at` / `notes.trashed_at` / `notes.created_at` 在 schema 里是 drizzle `mode: 'timestamp_ms'` 列，底层存 INTEGER ms —— 可以直接 `?` 绑 number。drizzle layer 不路过，这里走 raw better-sqlite3 prepare
- **关键不变量**：apply 路径**永远不**调用 `createNote` / `updateNote` 等 core mutation 函数，避免无限 echo loop

### 7.5 tags / FTS / notes_fts —— P5-a 明确不 apply

`syncNoteTags`（`packages/core/src/notes/index.ts:635` 附近）维护三处状态：
1. `tags` 主表（lookup-or-insert per tag_type / tag_value）
2. `note_tags` join 表（清空重建）
3. `notes_fts.tags_text`（FTS5 索引专列，触发器**不**自动同步，由业务层 `updateFtsTagsText` 维护）

P5-a 的 apply 路径**完全跳过** tags 处理（create / update 时即使 payload 含 `tags` 字段也不写）。理由：
- 三件状态联动 + FTS 同步是非平凡逻辑；裸 SQL 重写一遍既容易遗漏 FTS 又脱离 `syncNoteTags` 这个 source-of-truth
- 把 `syncNoteTags` 抽出来给 apply 复用要做小重构（去掉它对 mutation 上下文的隐式依赖），不属于 P5-a 范围
- 对 P5-a 验收（"note 双向收敛"）的核心证明 — content / folder_id / trash 状态 / 物理删除 — 不依赖 tags
- B 设备上 apply 完成后看到的 note 没有 tags 关系是已知缺陷，会在 §13.4 / §13.5 验收里**明示**

**push 端**：emit 仍正常带 `tags` 字段（`createNote` / `updateNote` 现有行为不变），上传到 server。server payload 透明、不验证。P5-b 上 tags apply + FTS 时，旧的上传记录就能被消费。

apply 端 P5-a 的 log 行：`[sync] apply note ${entityId} create/update — tags field present in payload (size N), skipped (P5-a)`。日志便于 P5-b 验证 backfill。

### 7.6 `sync_cursor` 写入用 upsert

schema v4 创建 `sync_cursor (endpoint TEXT PRIMARY KEY, pulled_seq, pushed_seq, updated_at NOT NULL)`，**首次 sync 时表里没有这个 endpoint 的行**。直接 `UPDATE` 会命中 0 行、cursor 永远不前进；`INSERT` 又会在第二次 sync 时撞 PK。所有 `sync_cursor` 写入**必须**用 upsert：

```ts
function upsertSyncCursor(
  sqlite: Database.Database,
  endpoint: string,
  fields: { pulledSeq?: number; pushedSeq?: number; nowMs: number },
): void {
  // INSERT 提供完整初值；ON CONFLICT 只更新本次提供的字段
  sqlite.prepare(`
    INSERT INTO sync_cursor (endpoint, pulled_seq, pushed_seq, updated_at)
    VALUES (?, COALESCE(?, 0), COALESCE(?, 0), ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      pulled_seq = COALESCE(excluded.pulled_seq, sync_cursor.pulled_seq),
      pushed_seq = COALESCE(excluded.pushed_seq, sync_cursor.pushed_seq),
      updated_at = excluded.updated_at
  `).run(endpoint, fields.pulledSeq ?? null, fields.pushedSeq ?? null, fields.nowMs);
}
```

注意：
- 列默认 `0`，确保首次 INSERT 时未提供的列也满足 `NOT NULL`（schema v4 里 `pulled_seq` / `pushed_seq` 都是 `NOT NULL DEFAULT 0`，但 INSERT 写 NULL 仍会触发约束，所以这里 `COALESCE(?, 0)` 兜底）
- `ON CONFLICT` 分支只覆盖本次提供的字段（pull 阶段只动 pulled_seq；push 阶段只动 pushed_seq）
- `updated_at` 永远更新

pull 调用：`upsertSyncCursor(sqlite, serverUrl, { pulledSeq: cursor, nowMs })`
push 调用：`upsertSyncCursor(sqlite, serverUrl, { pushedSeq: maxServerSeq, nowMs })`

### 7.5 失败语义与并发

- pull 中失败 → 已写入的事务保持；未完成的 batch 回滚；cursor 不前进；下次重试
- push 中网络失败 → outbox 行 `synced_at` 保持 NULL；下次 runSync 重放（cid 不变，server 回 duplicates，server_seq 一致）
- push 中部分失败（accepted/duplicates 没覆盖到所有 cid）→ 未被覆盖的 cid 不回填，下次重放
- **并发**：daemon 模块级 `let inFlight: Promise<RunSyncResult> | null`；第二个并发 runSync 请求复用同一个 Promise。CLI / GUI / 未来后台触发都走同一 dedupe。

## 8. daemon endpoints + adapter

### 8.1 路由 `packages/daemon/src/routes/sync.ts`

```ts
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';
import { runManualSync, runManualLogin, readSyncStatus } from '../sync/manual.js';

export function registerSyncRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/sync/run', async (_req, reply) => {
    try {
      const result = await runManualSync(ctx);
      return ok(reply, result);
    } catch (err) {
      return fail(reply, statusFor(err), messageFor(err), codeFor(err));
    }
  });

  app.get('/sync/status', async (_req, reply) => {
    try {
      return ok(reply, await readSyncStatus(ctx));
    } catch (err) {
      return fail(reply, 500, messageFor(err), codeFor(err));
    }
  });

  app.post('/sync/login', async (req, reply) => {
    const body = req.body as { email?: string; password?: string };
    if (!body?.email || !body?.password) {
      return fail(reply, 400, 'email and password required', 'USAGE_ERROR');
    }
    try {
      const result = await runManualLogin(ctx, body.email, body.password);
      return ok(reply, result);
    } catch (err) {
      return fail(reply, statusFor(err), messageFor(err), codeFor(err));
    }
  });
}
```

注意 helper 正签名：`ok(reply, data)` / `fail(reply, status, message, errorCode)` —— 沿用现有 `response.ts:12/22` 的 shape。

### 8.2 Adapter `packages/daemon/src/sync/manual.ts`

`@skybridge/client` 永远走 **非字面量 dynamic import**。**字面量 import specifier 仍会被 TypeScript 用 module resolution 解析、推断类型 —— 干净 checkout 不装 skybridge 时 `tsc -b` 直接炸**。必须用变量 specifier，让 TS 退化为 `any` / `unknown`，再用本地结构化类型 cast。

core 通过 root re-export 提供 sync engine + config 读写（`@owl/core` 目前只有 `.` 一个 export，不引入子路径导出）：

```ts
// packages/core/src/index.ts (新增 re-exports)
export { runSync } from './sync/engine.js';
export type { SkybridgeClientLike, LocalChangeLike, ServerChangeLike,
              PullResultLike, PushResultLike, PushAckLike,
              RunSyncDeps, RunSyncResult } from './sync/engine.js';
export * as syncPayloads from './sync/payloads/note.js';
export * as skybridgeConfig from './skybridge/config.js';
```

```ts
// packages/daemon/src/sync/manual.ts
import {
  runSync,
  skybridgeConfig,
  type RunSyncResult,
  type SkybridgeClientLike,
} from '@owl/core';

// Local structural shape — what we actually call. NOT imported from
// @skybridge/client; that package may be absent on a clean checkout.
interface SkybridgeClientModule {
  CLIENT_VERSION: string;
  login(serverUrl: string, email: string, password: string): Promise<{
    serverUrl: string; token: string; user: { id: string; email: string };
  }>;
  createSkybridgeClient(opts: {
    authContext: { serverUrl: string; token: string; user: { id: string; email: string } };
    deviceId?: string;
  }): {
    registerDevice(input: { name: string; appVersion: string; clientVersion: string }):
      Promise<{ id: string; name: string }>;
    ensureWorkspace(tool: string, name: string): Promise<{ id: string; slug?: string }>;
    pushChanges(workspaceId: string, changes: LocalChangeLike[]):
      Promise<{ accepted: PushAckLike[]; duplicates: PushAckLike[]; latestSeq: number }>;
    pullChanges(workspaceId: string, sinceSeq: number, limit?: number):
      Promise<{ changes: ServerChangeLike[]; hasMore: boolean; latestSeq: number }>;
  };
}

async function loadSkybridgeClient(): Promise<SkybridgeClientModule> {
  // Non-literal specifier: TS gives this `Promise<any>` and skips resolution.
  // Without this, `tsc -b` on a clean checkout (no skybridge installed) fails.
  const spec: string = '@skybridge/client';
  try {
    return (await import(spec)) as SkybridgeClientModule;
  } catch (err) {
    throw new SkybridgeNotInstalledError(err);
  }
}

export async function runManualSync(ctx: AppContext): Promise<RunSyncResult> {
  const config = await skybridgeConfig.readConfig();
  if (!config?.server?.url) throw new SkybridgeNotConfiguredError();
  if (!config?.auth?.token) throw new SkybridgeAuthRequiredError();

  const sb = await loadSkybridgeClient();
  // skybridge AuthContext shape: { serverUrl, token, user } —— 无 expiry
  let client = sb.createSkybridgeClient({
    authContext: {
      serverUrl: config.server.url,
      token: config.auth.token,
      user: { id: config.auth.user_id, email: config.auth.email ?? '' },
    },
    deviceId: config.device?.id,
  });

  if (!config.device?.id) {
    const device = await client.registerDevice({
      name: defaultDeviceName(),
      appVersion: `owl ${ctx.appVersion}`,
      clientVersion: sb.CLIENT_VERSION,
    });
    config.device = { id: device.id, name: device.name, app_version: `owl ${ctx.appVersion}`, client_version: sb.CLIENT_VERSION };
    client = sb.createSkybridgeClient({ /* ... 带 deviceId */ });
    await writeConfig(config);
  }
  if (!config.workspace?.id) {
    const ws = await client.ensureWorkspace('owl', 'default');
    config.workspace = { id: ws.id, slug: 'owl/default' };
    await writeConfig(config);
  }

  return runSync({
    sqlite: ctx.sqlite,
    client: adaptClient(client),       // wraps SkybridgeClient → SkybridgeClientLike
    workspaceId: config.workspace.id,
    serverUrl: config.server.url,
    logger: ctx.logger,
  });
}
```

`adaptClient` 是一段 ~10 行的 shape 转换。core 层完全不知道 `@skybridge/client` 存在。

**inflight dedupe** 在 `manual.ts` 模块顶层：

```ts
let inFlight: Promise<RunSyncResult> | null = null;
export async function runManualSync(ctx: AppContext): Promise<RunSyncResult> {
  if (inFlight) return inFlight;
  inFlight = doRunManualSync(ctx).finally(() => { inFlight = null; });
  return inFlight;
}
```

### 8.3 server 注册（`server.ts`）

```ts
import { registerSyncRoutes } from './routes/sync.js';
// ...
registerSyncRoutes(app, ctx);
```

启动期不预检 skybridge config（避免依赖文件存在）；首次 sync route 调用时按需检查。daemon 启动 log 一行 `skybridge: <enabled|disabled>`，便于 debug。"enabled" 判定 = `skybridge_config.toml` 存在且 `[server].url` 非空。

## 9. CLI `owl sync` 命令族（零 skybridge 依赖）

`apps/cli/src/commands/sync.ts` 全部走 daemon HTTP。

### 9.1 子命令

```
owl sync run                              # POST /sync/run
owl sync status                           # GET  /sync/status
owl sync login --email <e>                # POST /sync/login (password 通过 readline 隐藏输入)
owl sync config show                      # 读 ~/orpheus-aviary-nest/skybridge/skybridge_config.toml 本地打印（token 屏蔽）
```

### 9.2 action wrapper（不复用 `withContext`）

```ts
// apps/cli/src/commands/sync.ts
import { detectDaemon } from '../lib/daemon-detect.js';
import { resolveConfig } from '../lib/config.js';
import { CliError } from '../lib/errors.js';

async function withDaemonHttp<T>(opts: GlobalOptions, fn: (port: number) => Promise<T>): Promise<T> {
  const cfg = resolveConfig({ ... });
  const alive = await detectDaemon(cfg.daemon.port);
  if (!alive) {
    throw new CliError('DAEMON_UNAVAILABLE', 'daemon is not running; start it with `owl-daemon` first');
  }
  return fn(cfg.daemon.port);
}
```

`DAEMON_UNAVAILABLE` 是现有错误码（`apps/cli/src/lib/errors.ts:15`），映射到 `EXIT_CODES.DAEMON_UNAVAILABLE`。`owl sync login` **不**走 `withDaemonHttp` 的"daemon 必须存活"判定吗？错——`login` 也必须走 daemon HTTP（daemon 在但 skybridge config 缺失也能调，daemon 路由会处理），所以同样需要 daemon 存活。daemon 启动不依赖 skybridge config，这两件事不矛盾。

### 9.3 `--direct` 禁用 sync

`owl sync run --direct` / `--direct` 在任何 sync 子命令下立即报错：
```
sync commands require the daemon; --direct is not supported
exit code: USAGE_ERROR
```

理由：sync engine 在 daemon 进程里持有 inflight dedupe + 共享 sqlite handle，CLI direct 再开一条 sqlite 连接会撞 SQLITE_BUSY。

### 9.4 注册

`apps/cli/src/index.ts` 加：

```ts
import { runSync, runSyncStatus, runSyncLogin, runSyncConfigShow } from './commands/sync.js';

const syncCmd = program.command('sync').description('skybridge sync (P5-a manual)');
syncCmd.command('run').description('trigger one manual sync').action(runSync);
syncCmd.command('status').description('show sync status').action(runSyncStatus);
syncCmd.command('login').requiredOption('--email <email>').action(runSyncLogin);
const configCmd = syncCmd.command('config').description('inspect skybridge config');
configCmd.command('show').action(runSyncConfigShow);
```

sync 命令的 action 都不用 `withContext`（不需要 OwlBackend）。它们直接 fetch daemon。

## 10. 本地 pack / 安装

### 10.1 skybridge 仓产物

三 tarball：`@skybridge/proto@0.1.0` / `@skybridge/client@0.1.0` / `@skybridge/server@0.1.0`，输出到 `skybridge/dist-pack/`。

**版本号来源**：每个 package 的 `package.json.version` 直接读，不依赖 lockfile。

**workspace 版本解析**：generator 维护 `workspaceVersions = { '@skybridge/proto': '0.1.0', '@skybridge/client': '0.1.0', '@skybridge/server': '0.1.0' }`，把 manifest 里 `workspace:*` 全部换成对应版本。

**bundledDependencies**：因为我们暂不 npm publish，client 和 server 的 publishable manifest 把 `@skybridge/proto` 列进 `bundledDependencies`，pack 前把 proto 的 `dist/` 复制到自身 `dist/node_modules/@skybridge/proto/`，`npm pack` 把 bundled 部分一并打进 tarball。下游一条 `pnpm add ./skybridge-client-0.1.0.tgz` 就跑。

**正式 npm publish 时**：移除 `bundledDependencies`，proto 改普通 `dependencies`，三包同发。本 design doc 留好钩子，不立即做。

### 10.2 生产 tsconfig 拆分

当前 `packages/{client,server}/tsconfig.json` `include` 包含 `test/**/*.ts`，且 client 还 references `../server`（test 需要）。pack 时会把测试产物 / 测试用的 server 类型一并带进 tarball，臃肿且暴露不该暴露的依赖。

每个 package 加 `tsconfig.build.json`：

```json
// packages/client/tsconfig.build.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "rootDir": "./src",
    "tsBuildInfoFile": "./dist/.tsbuildinfo.build"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "test", "**/*.test.ts"],
  "references": [{ "path": "../proto/tsconfig.build.json" }]
}
```

类似的 `packages/proto/tsconfig.build.json` / `packages/server/tsconfig.build.json`（server 的 `rootDir` 包含 `src` 和 `bin`，调整成 `./` + include 限定）。

`package.json` 的 `build` script：
```json
"build": "tsc -b tsconfig.build.json"
```

`just build-*` recipes 沿用 pnpm run build，自动走新 build tsconfig。

pack 流程**额外**加一道保险：
```bash
find dist -name '*.test.*' -delete
```
之后再 `npm pack`。

### 10.3 skybridge just recipes（新增）

```just
# ─── Pack (local distribution) ───────────────────────

[group('pack')]
pack-all: pack-clean pack-proto pack-client pack-server
    @echo "[pack] all tarballs in dist-pack/"
    @ls -1 dist-pack/

[group('pack')]
pack-proto: build-proto
    node packages/proto/scripts/gen-publishable-manifest.mjs
    find packages/proto/dist -name '*.test.*' -delete || true
    cd packages/proto/dist && npm pack --pack-destination ../../../dist-pack

[group('pack')]
pack-client: build-client pack-proto
    node packages/client/scripts/gen-publishable-manifest.mjs
    find packages/client/dist -name '*.test.*' -delete || true
    cd packages/client/dist && npm pack --pack-destination ../../../dist-pack

[group('pack')]
pack-server: build-server pack-proto
    node packages/server/scripts/gen-publishable-manifest.mjs
    find packages/server/dist -name '*.test.*' -delete || true
    cd packages/server/dist && npm pack --pack-destination ../../../dist-pack

[group('pack')]
pack-clean:
    rm -rf dist-pack/
    mkdir -p dist-pack/
```

`pack-client` / `pack-server` 依赖 `pack-proto`：proto 的 dist 已经准备好供它们 cp 到自身 `dist/node_modules/@skybridge/proto/`。

### 10.4 每个包的 `scripts/gen-publishable-manifest.mjs`

骨架：

```js
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const repoRoot = join(pkgDir, '..', '..');

const workspaceVersions = {
  '@skybridge/proto':  JSON.parse(readFileSync(join(repoRoot, 'packages/proto/package.json'), 'utf8')).version,
  '@skybridge/client': JSON.parse(readFileSync(join(repoRoot, 'packages/client/package.json'), 'utf8')).version,
  '@skybridge/server': JSON.parse(readFileSync(join(repoRoot, 'packages/server/package.json'), 'utf8')).version,
};

const workspacePkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

function resolveDeps(input = {}) {
  const out = {};
  for (const [name, range] of Object.entries(input)) {
    out[name] = range === 'workspace:*' ? workspaceVersions[name] : range;
  }
  return out;
}

const publishable = {
  name: workspacePkg.name,
  version: workspacePkg.version,
  type: 'module',
  ...PACKAGE_SPECIFIC_FIELDS,   // main / bin / exports / files / etc., each package defines its own
  dependencies: resolveDeps(workspacePkg.dependencies),
  ...(workspacePkg.dependencies?.['@skybridge/proto']
    ? { bundledDependencies: ['@skybridge/proto'] }
    : {}),
  engines: { node: '>=22.0.0' },
  repository: { type: 'git', url: 'https://github.com/orpheus-aviary/skybridge' },
  license: 'MIT',
};

const distDir = join(pkgDir, 'dist');
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, 'package.json'), `${JSON.stringify(publishable, null, 2)}\n`);

copyFileSync(join(repoRoot, 'LICENSE'), join(distDir, 'LICENSE'));
if (existsSync(join(pkgDir, 'README.md'))) {
  copyFileSync(join(pkgDir, 'README.md'), join(distDir, 'README.md'));
}

// client / server: 把 proto 的 dist 内联进 node_modules
if (workspacePkg.dependencies?.['@skybridge/proto']) {
  const protoDist = join(repoRoot, 'packages/proto/dist');
  const target   = join(distDir, 'node_modules/@skybridge/proto');
  mkdirSync(target, { recursive: true });
  cpSync(protoDist, target, { recursive: true });
  copyFileSync(
    join(repoRoot, 'packages/proto/dist/package.json'),
    join(target, 'package.json'),
  );
}

// server: 顺带拷 openapi.yaml（样本，runtime 不需要）
if (workspacePkg.name === '@skybridge/server') {
  const openapi = join(repoRoot, 'packages/proto/openapi.yaml');
  if (existsSync(openapi)) copyFileSync(openapi, join(distDir, 'openapi.yaml'));
}
```

每个包的 `PACKAGE_SPECIFIC_FIELDS` 在自己的 generator 内置常量。

## 11. owl 仓的本地消费

### 11.1 设计原则

- daemon **运行时**：dynamic import `@skybridge/client`，无 top-level 类型依赖
- daemon **测试**：dynamic import `@skybridge/server`，无 top-level 类型依赖
- core：零 skybridge 依赖
- CLI：零 skybridge 依赖
- `packages/daemon/package.json` git committed 状态**不含**任何 `@skybridge/*`
- `apps/cli/package.json` 同上
- root `package.json` 的 `pnpm.overrides` git committed 状态**不含** `@skybridge/*`
- `just check` 加守卫，发现以上任何 manifest 含 `@skybridge/` 即 fail

### 11.2 `skybridge-install` / `-uninstall` 行为

**install**（`scripts/skybridge-overrides.mjs install <dist-pack-dir>`）：
1. 扫 `<dist-pack-dir>/skybridge-*.tgz`，对 `proto` / `client` / `server` 三个 tarball 各拿到一个绝对路径
2. patch root `package.json`：
   ```json
   "pnpm": {
     "overrides": {
       "@skybridge/proto":  "file:<abs path to skybridge-proto-X.Y.Z.tgz>",
       "@skybridge/client": "file:<abs path to skybridge-client-X.Y.Z.tgz>",
       "@skybridge/server": "file:<abs path to skybridge-server-X.Y.Z.tgz>"
     }
   }
   ```
   只动 `pnpm.overrides` 里的 `@skybridge/*` 三个 key，其它 overrides 原样保留
3. patch `packages/daemon/package.json`：
   - `dependencies: { "@skybridge/client": "^0.1.0" }`
   - `devDependencies: { "@skybridge/server": "^0.1.0" }`
4. `pnpm install` —— 让 lockfile 接受 file: 路径

**uninstall**：
1. 反向移除 root overrides 中的 `@skybridge/*` 三条
2. 反向移除 `packages/daemon/package.json` 中的 `@skybridge/client` / `@skybridge/server`
3. `pnpm install` —— 恢复 lockfile 到无 skybridge 状态

脚本是原子操作：要么三步全成、要么全回滚（用 try/finally + before-snapshot）。

### 11.3 守卫脚本 `scripts/check-skybridge-not-committed.sh`

```bash
#!/usr/bin/env bash
# Fail if committed manifests reference @skybridge/*. Forces skybridge-install
# state to be local-only (uncommitted), enforcing the "never commit unreleased
# packages as deps" invariant.
set -euo pipefail

violations=()
for f in package.json packages/daemon/package.json apps/cli/package.json; do
  if grep -q '"@skybridge/' "$f" 2>/dev/null; then
    violations+=("$f")
  fi
done

if [ ${#violations[@]} -gt 0 ]; then
  echo "[guard] committed manifest references @skybridge/* — run 'just skybridge-uninstall' first:" >&2
  printf '  %s\n' "${violations[@]}" >&2
  exit 1
fi
echo "[guard] no @skybridge/* in committed manifests — ok"
```

接入 `just check` 链：

```just
[group('lint')]
check: lint typecheck core-convergence skybridge-not-committed
    @echo "All checks passed."

[group('lint')]
skybridge-not-committed:
    bash scripts/check-skybridge-not-committed.sh
```

### 11.4 owl 仓新增 just recipes

```just
# ─── Skybridge debug ─────────────────────────────────
#
# P5-a: skybridge 还没 npm publish。下游通过本地 tarball 接入。
# 这一组 recipe 是 owl 开发者一键开/关 skybridge 调试链路的入口。
# 注意：执行 skybridge-install 后 packages/daemon/package.json 与 root
# package.json 会被临时改动，**绝对不能 commit**。`just check` 有守卫。

# 默认假设 skybridge 仓在 owl 仓的同级目录
skybridge_dir := "../skybridge"

[group('skybridge')]
skybridge-install:
    node scripts/skybridge-overrides.mjs install {{skybridge_dir}}/dist-pack
    pnpm install

[group('skybridge')]
skybridge-uninstall:
    node scripts/skybridge-overrides.mjs uninstall
    pnpm install

[group('skybridge')]
skybridge-server config="":
    cd {{skybridge_dir}} && just config={{ if config == "" { "./server.toml" } else { config } }} server-start

[group('skybridge')]
skybridge-sync-once:
    bash scripts/skybridge-sync-once.sh

[group('skybridge')]
dev-skybridge:
    bash scripts/dev-skybridge.sh

# Run daemon's *.e2e.ts suite which needs in-process skybridge server.
# Requires `just skybridge-install` first. SKYBRIDGE_E2E=1 unlocks describe gate.
# node:test glob targets `*.e2e.js` (no `.test.` suffix), keeping it disjoint
# from the default `*.test.js` glob — so `just test` never touches it.
[group('skybridge')]
test-skybridge-e2e: ensure-node-abi build-daemon
    SKYBRIDGE_E2E=1 pnpm --filter @owl/daemon run test:e2e
```

**关键不变量**：`just test`（默认走 `*.test.js`）永远不会匹配 `.e2e.js`；`describe('...', { skip: !SKYBRIDGE_E2E }, ...)` 是双保险。两层防御保证干净 checkout `just test` + `tsc -b` 都不会试图解析 `@skybridge/server`。

`scripts/skybridge-sync-once.sh`（honor `OWL_NEST_DIR`，避免 profile B 误连 profile A 的 daemon 端口）：

```bash
#!/usr/bin/env bash
set -euo pipefail

# Nest dir resolution mirrors packages/core/src/config/paths.ts (Step 0a).
NEST_DIR="${OWL_NEST_DIR:-$HOME/orpheus-aviary-nest}"

# 端口解析委托给 packages/core/scripts/read-daemon-port.mjs —— 它在 core 包内，
# pnpm 能解析它依赖的 smol-toml。**不**用 root `node -e require('smol-toml')`：
# root package.json 不声明 smol-toml，pnpm 默认 strict hoisting 下找不到。
PORT=$(OWL_NEST_DIR="$NEST_DIR" node packages/core/scripts/read-daemon-port.mjs)

echo "[sync-once] nest=$NEST_DIR port=$PORT"
curl --fail --silent -X POST "http://127.0.0.1:${PORT}/sync/run" | jq .
```

`packages/core/scripts/read-daemon-port.mjs`（commit 进 owl 仓，调试期 / 正式发版都用得着）：

```js
#!/usr/bin/env node
// Print the owl daemon port from $OWL_NEST_DIR/owl/owl_config.toml.
// Falls back to DEFAULT_CONFIG.daemon.port (47010) on any read/parse failure.
//
// Lives in packages/core/scripts/ so pnpm resolves `smol-toml` via core's
// dependency tree — works regardless of root hoisting settings.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

const DEFAULT_PORT = 47010;
const nest = process.env.OWL_NEST_DIR ?? join(homedir(), 'orpheus-aviary-nest');

try {
  const cfg = parse(readFileSync(join(nest, 'owl', 'owl_config.toml'), 'utf8'));
  const port = cfg?.daemon?.port;
  console.log(typeof port === 'number' ? port : DEFAULT_PORT);
} catch {
  console.log(DEFAULT_PORT);
}
```

`scripts/dev-skybridge.sh` 同样 honor `OWL_NEST_DIR` 并复用上面的 helper 读 port。

`scripts/dev-skybridge.sh`：起本地 server（后台）→ 起 daemon（后台）→ 起 GUI（前台），trap EXIT 清理后台 PID。第一版只 macOS / Linux。

## 12. 测试矩阵

### 12.1 core 单测（`node:test`，文件放 `packages/core/src/sync/*.test.ts`）

owl core 的 test runner 是 `node:test`（同 daemon）。`packages/core/tsconfig.json` 的 `include` 只覆盖 `src/`，所以测试文件必须落在 `src/` 内（沿用既有 `packages/core/src/db/probe.test.ts` 等的位置惯例）。

测试 import 形态：`import { describe, it, before } from 'node:test'; import assert from 'node:assert/strict';`

| Case | 期望 |
|---|---|
| `emitSyncChange` 返回 cid 且写入新列 | DB `client_change_id` = 返回值 |
| **Step 0b 回归**：`permanentDeleteNote` / `batchPermanentDeleteNotes` emit 的 payload 含 `updated_at_ms: number` | DB row.payload JSON 解出来字段存在且类型对 |
| **0005 backfill 回归**：迁移前 owl.db 有 `op='delete' payload='{}'` 的旧行，迁移后变成 `{"updated_at_ms": <created_at>}` | 用 v4 fixture db 走 migration runner，断言 payload 改写正确 |
| **`emitSyncChange` 不**调 validator | mock 一个 invalid note payload 喂进去也能成功写入 sync_changes（emit 端不防御；apply 端才防御） |
| `parseNotePayload` 5 个 content op 合法 payload 通过 | 不抛 |
| `parseNotePayload` 对 `pin` / reorder-shape payload 调用应被 caller 屏蔽（§3.1 规则 2 提前 skip）—— 测试覆盖 caller 路径而非 validator | apply path skip + 不调用 validator |
| `parseNotePayload` 缺 `updated_at_ms` 抛 `NotePayloadInvalidError` | reason 包含 `updated_at_ms` |
| `runSync` 空 outbox + 空 server pull → noop | 不动 sync_changes / sync_cursor |
| `runSync` 首次跑（sync_cursor 该 endpoint 行不存在）→ upsert INSERT 新行 | DB 出现一行 `endpoint=<url>`，`pulled_seq`/`pushed_seq` 反映本次结果 |
| `runSync` 协议错误（`changes.length === 0 && hasMore === true`） | throw `SkybridgeProtocolError`，cursor 不前进 |
| `runSync` 1 行 pending push → 回填 server_seq / synced_at | 行变成 synced |
| `runSync` push 失败（Fake client 抛 NetworkError）→ 行不被回填 | sync_changes 保持 pending，cursor 不动 |
| `runSync` server 返回 duplicates → 也回填 | synced_at 设置 |
| `runSync` server pull n 条 note create → 全部 apply 到 notes 表 | notes 表行数正确 |
| apply create / update 写入 `content_hash` = `contentHash(content)` | DB 行 `content_hash` 等于 hash(content)；update 不带 content 时 hash 不动 |
| apply create / update / trash / restore 写入 `device_id` = `ServerChange.deviceId` | DB 行 `device_id` 等于 remote 来源设备 |
| apply create payload 含 `tags` → tags 字段被 skip，log 行包含 "skipped (P5-a)"，`note_tags` 不写入 | DB 中 note_tags 行数为 0；spy 的 logger 收到该行 |
| apply update / trash / restore 在本地 note 不存在时 → skip + 计数 skippedTotal | SQL changes=0 不抬升 appliedTotal |
| apply delete 在本地 note 不存在时 → idempotent skip | SQL changes=0 → returns 'skipped'（不报错） |
| `runSync` pull 含 cid 命中本地 synced 行 → skip + cursor 推进 | notes 表不变 |
| `runSync` pull note.updated_at_ms < local.updated_at → skip | LWW loser |
| `runSync` pull note.updated_at_ms == local.updated_at → skip（tie） | 不覆盖 |
| `runSync` pull note delete with local.updated_at > remote → skip + log | 不删除 |
| `runSync` pull non-note entity → 跳过 apply 但 cursor 推进 | folder/conv 不在 notes 表出现 |
| `runSync` pull payload validator 失败 → 整 batch 回滚 | cursor 不前进 |
| `runSync` pull 多 batch hasMore=true→false → 全部消费 | 最终 cursor 正确 |
| `runSync` 并发两个调用复用 inflight Promise | 底层 client 只被调一次（在 daemon adapter 测，不在 core） |

mock：实现 minimal `FakeSkybridgeClient implements SkybridgeClientLike`，无网络。

### 12.2 daemon 集成测（`packages/daemon/src/sync/sync.e2e.ts`）

**注意：owl daemon 和 core 用的是 `node:test`（`packages/daemon/package.json:13` 跑 `node --test 'dist/**/*.test.js'`），不是 vitest**。P5-a 不引入 vitest（那是独立 refactor）。

**Gating 两层防御**：

1. **Filename-based glob 隔离**：e2e 测试文件**不带** `.test.` 后缀，命名为 `sync.e2e.ts` —— tsc 编译出 `dist/sync/sync.e2e.js`，default `node --test 'dist/**/*.test.js'` glob 不会匹配它
2. **运行时 skip**：suite 顶层用 `describe('...', { skip: !process.env.SKYBRIDGE_E2E }, () => { ... })`，即使 e2e recipe 错误地用 default glob 跑了，没设 env 也直接 skip 整组

**导入也用非字面量 specifier**，理由同 §8.2 —— 干净 checkout 上 `tsc -b` 会试图解析字面量 import 的类型。

```ts
// packages/daemon/src/sync/sync.e2e.ts  ← 注意：不带 .test.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Structural shape of @skybridge/server. NOT imported as a type; package may be absent.
interface SkybridgeServerModule {
  defaultConfig(dir: string): { storage: { dbPath: string }; logging: { level: string; file: string | null } };
  openDb(opts: { path: string; requireMigrationsApplied: boolean }): { close(): void };
  applyMigrations(db: unknown): void;
  buildApp(opts: { config: unknown; logger: false }): Promise<{
    app: { listen(opts: object): Promise<void>; close(): Promise<void>; server: { address(): { port: number } | string | null } };
    db: unknown;
  }>;
  createUser(db: unknown, input: { email: string; password: string }): Promise<unknown>;
}

const gate = process.env.SKYBRIDGE_E2E === '1';

describe('sync e2e (in-process skybridge)', { skip: !gate }, () => {
  let server: { baseUrl: string; cleanup: () => Promise<void> };

  before(async () => {
    const spec: string = '@skybridge/server';
    const sb = (await import(spec)) as SkybridgeServerModule;
    const tmp = mkdtempSync(join(tmpdir(), 'sync-e2e-'));
    const config = sb.defaultConfig(tmp);
    config.logging.file = null;
    config.logging.level = 'error';
    const initDb = sb.openDb({ path: config.storage.dbPath, requireMigrationsApplied: false });
    sb.applyMigrations(initDb);
    initDb.close();
    const built = await sb.buildApp({ config, logger: false });
    await built.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = built.app.server.address();
    if (!addr || typeof addr !== 'object') throw new Error('no port');
    await sb.createUser(built.db, { email: 'jay@x.test', password: 'longenoughpw' });
    server = {
      baseUrl: `http://127.0.0.1:${addr.port}`,
      cleanup: async () => {
        await built.app.close();
        rmSync(tmp, { recursive: true, force: true });
      },
    };
  });

  after(async () => { await server.cleanup(); });

  it('first sync: pull empty, push pending', async () => {
    // exercise POST /sync/run + assert RunSyncResult shape
    // ...
  });
  // ... 更多 case
});
```

**daemon test 入口配置**：

`packages/daemon/package.json`：
```json
"scripts": {
  "test": "node --test 'dist/**/*.test.js'",
  "test:e2e": "node --test 'dist/**/*.e2e.js'"
}
```

`packages/daemon/tsconfig.json` 沿用现有 `include: ['src/**/*.ts']`（已经覆盖 `.e2e.ts`，因为它仍是 `.ts`），不需要改 ts config。

**关键不变量**：默认 `pnpm --filter @owl/daemon run test`（即 `just test-daemon`）**只匹配 `*.test.js`**，永远不会触碰 `.e2e.js`。即使有人手动 `node --test 'dist/**/*.e2e.js'` 没设 env，`{ skip: !gate }` 兜底。

| Case | 期望 |
|---|---|
| `POST /sync/run` 无 config → 500 + `SKYBRIDGE_NOT_CONFIGURED` | body.error_code 正确，body.message 非空 |
| `POST /sync/login` 写入 toml；后续 `POST /sync/run` 成功 | toml 文件存在，sync 返回 RunSyncResult |
| `POST /sync/run` 单 note create → server 接受，本地 sync_changes 回填 | server_seq > 0 |
| `POST /sync/run` 第一次（server 空，本地 1 条 pending）→ `pulledTotal = 0`, `pushedTotal = 1` | 本地 sync_changes 回填 |
| `POST /sync/run` 第二次（server 已有自己 echo）→ `pulledTotal = 1`, `appliedTotal = 0`（cid self-replay skip）, `pushedTotal = 0` | 不动 notes 表，cursor 推进 |
| `GET /sync/status` 返回 pending / cursor / last_sync | 字段齐 |
| 并发两个 `POST /sync/run` → inflight 复用 | 底层 client.pushChanges 只调用一次（spy） |
| skybridge server 停掉 → `POST /sync/run` 返回 `SKYBRIDGE_SERVER_UNREACHABLE` | error_code 正确 |
| `--direct` 模式 sync route 不影响（route 本身 daemon-only） | n/a |

### 12.3 cli 单测（`apps/cli/src/commands/sync.test.ts`）

mock fetch（沿用现有 commands/*.test.ts 模式）。

| Case | 期望 |
|---|---|
| `owl sync run` → POST /sync/run，pretty 打印 result | exit 0 |
| `owl sync run --direct` → stderr + USAGE_ERROR | exit code 对 |
| `owl sync status` → GET /sync/status 渲染 | exit 0 |
| `owl sync login` → 提示 password（readline，不回显），POST /sync/login | toml 通过 daemon 写入 |
| daemon 未启动 → DAEMON_UNAVAILABLE | exit code 对（沿用现有码） |
| `owl sync config show` → 屏蔽 token 输出 | 不打印 token 实值 |

### 12.4 手动验收清单（§13）

**单机双 profile 必须通过**才算 P5-a ship；双机 / 远程 server 验收推迟到 P5-c。

## 13. 手动验收清单

> P5-a 验收：必须**单机双 profile** 跑通。双机 / 远程 server 暂不在验收范围（P5-c 再讨论）。

### 13.1 准备

测试步骤：
1. **干净 checkout 验证**：`just skybridge-uninstall` 后跑 `just test` + `just check`（含 typecheck）
   → 预期：全绿；TypeScript 不应试图解析 `@skybridge/*`（验证非字面量 dynamic import + e2e gating 都生效）；e2e 套件文件 `*.e2e.js` 不被默认 `node --test 'dist/**/*.test.js'` glob 匹配，整组 silently 不跑
2. 在 `skybridge/` 跑 `just pack-clean && just pack-all`
   → 预期：`skybridge/dist-pack/` 下出现 `skybridge-proto-0.1.0.tgz` / `skybridge-client-0.1.0.tgz` / `skybridge-server-0.1.0.tgz`
3. 在 `owl/` 跑 `just skybridge-install`
   → 预期：root `package.json` 的 `pnpm.overrides` 出现三条 file: 路径；`packages/daemon/package.json` 加 client（deps）/ server（devDeps）；`pnpm install` 成功
4. `just check`
   → 预期：`skybridge-not-committed` 守卫**报错**（因为已经 install）。说明：守卫的目的是阻止误 commit；调试期跑 install 之后做完事情要 uninstall + commit 才能进 `just check` 干净状态
5. `just test-skybridge-e2e`
   → 预期：daemon e2e 套件运行（不再 skip），全绿
6. 用 `git stash` 或不 commit，继续后续测试

### 13.2 启 skybridge 本地 server

测试步骤：
1. `cd skybridge && just server-init`（首次创建 `~/orpheus-aviary-nest/skybridge/skybridge.db`）
   → 预期：migrations apply 成功
2. `just server-user-create email=jay@local password=longenoughpw`
   → 预期：CLI 报 created
3. `just server-start`（另一终端保持前台运行）
   → 预期：listening on 127.0.0.1:18443

### 13.3 单 profile push + self-replay 测试

测试步骤：
1. `cd owl && just dev-daemon`（另一终端，使用默认 nest dir = `~/orpheus-aviary-nest/owl/`）
   → 预期：daemon 起在 :47010
2. 在 owl GUI 或通过 daemon HTTP 创建 2 条 note
   → 预期：`owl.db.sync_changes` 出现 2 行，`synced_at IS NULL`
3. `owl sync login --email jay@local`（输入 password）
   → 预期：`~/orpheus-aviary-nest/skybridge/skybridge_config.toml` 写入 `[server]` `[auth]`
4. `just skybridge-sync-once`（**第一次**：pull→push，server 是空的）
   → 预期：返回 JSON，`pulledTotal = 0`、`appliedTotal = 0`、`pushedTotal = 2`，`serverSeqHigh` > 0；2 行 `sync_changes.synced_at IS NOT NULL`；`sync_cursor.pulled_seq` 仍为 0（pull 阶段无数据；pushed_seq 推进到 max(server_seq)）
5. 再 `just skybridge-sync-once`（**第二次**：pull→push，server 上已有自己 push 上去的 2 条）
   → 预期：`pulledTotal = 2`（自己的 echo）、`appliedTotal = 0`（cid 命中本地已 synced 行 → self-replay skip）、`pushedTotal = 0`、`sync_cursor.pulled_seq` 推进到 max(server_seq)
6. 第三次 sync
   → 预期：`pulledTotal = 0`、`pushedTotal = 0`，cursor 不变（稳态）
7. 重放：手动 `UPDATE sync_changes SET synced_at = NULL WHERE local_seq = (SELECT MAX(local_seq) FROM sync_changes)`，再 sync
   → 预期：第一阶段 pull 拉到自己的 echo 但 cid 命中其它已 synced 行 → skip；第二阶段发现 1 行 pending → push，server 返回 1 条 **duplicate**（cid 已存在），`synced_at` 被重新回填，`server_seq` 与之前相同

### 13.4 单机双 profile 双向收敛测试（**核心验收**）

**整段所有 owl 命令都必须带 `OWL_NEST_DIR=...` 前缀**，否则会串到 profile A 的 daemon / db。把"profile A"和"profile B"理解为两个 env-prefixed terminal session：

设置 profile B：
1. `mkdir -p $HOME/orpheus-aviary-nest-profileB/owl/`
2. 复制最小 owl_config.toml 到该目录，**改 `[daemon].port = 47011`**（避免和 profile A 撞端口）
3. 起 profile B daemon（另一终端 / 另一 tmux 窗口）：
   ```
   OWL_NEST_DIR=$HOME/orpheus-aviary-nest-profileB just dev-daemon
   ```
   预期：daemon 起在 `127.0.0.1:47011`
4. profile B login（**注意 env**）：
   ```
   OWL_NEST_DIR=$HOME/orpheus-aviary-nest-profileB owl sync login --email jay@local
   ```
   预期：写入 `~/orpheus-aviary-nest-profileB/skybridge/skybridge_config.toml`（device 段空，下一次 sync 时 daemon B 会 registerDevice 拿到一个新 device_id，与 A 不同）

测试步骤（每步都假定 prefix `OWL_NEST_DIR=...` 已套好；为简洁省略写）：

1. profile A 创建 note `note-shared` 内容 `"from A"`
2. profile A `just skybridge-sync-once` → 预期 `pushedTotal = 1`
3. profile B `just skybridge-sync-once`（在 B env 下；recipe 读 `$OWL_NEST_DIR/owl/owl_config.toml` 得到 port=47011）→ 预期 `pulledTotal >= 1`，`appliedTotal = 1`，profile B 的 `notes` 表（即 `~/orpheus-aviary-nest-profileB/owl/owl.db`）出现 `note-shared` 内容 `"from A"`，`content_hash` 已派生。**预期已知差异**：B 的 `note_tags` 表对该 note 行数为 0（P5-a 不 apply tags，见 §7.5）；daemon log 含 `tags field present in payload ... skipped (P5-a)` 行
4. profile B 修改该 note 为 `"from A, edited by B"`（注意 `updated_at` 自动推进）
5. profile B sync → 预期 `pushedTotal = 1`
6. profile A sync → 预期 `pulledTotal = 1`，`appliedTotal = 1`（B 的 updated_at_ms > A 的 local updated_at，LWW 胜出），profile A 的 notes 表更新到 `"from A, edited by B"`
7. profile A delete 该 note，profile B 同步 → 预期 profile B 该 note 物理删除
8. tie 测试：profile A 创建一条 note，profile B 拉回，B 不修改但手动 `UPDATE notes SET updated_at = <同样值>`，A 再 sync → 预期 B 的 LWW skip（tie）
9. **隔离守卫**：测试结束前 `grep "orpheus-aviary-nest/owl" ~/orpheus-aviary-nest-profileB/owl/logs/daemon.log` 必须**为空**；反向亦然。任何一边的 log 出现对方的路径字串，说明 Step 0a env override 有漏点

### 13.5 错误路径

测试步骤：
1. 删 profile A 的 `skybridge_config.toml`，调 `just skybridge-sync-once`
   → 预期：HTTP 500，body 含 `error_code: "SKYBRIDGE_NOT_CONFIGURED"`
2. profile A `[auth].token` 改成假值（模拟 token 失效），再 sync
   → 预期：API 401 → daemon 删 toml `[auth]`、返回 `SKYBRIDGE_AUTH_REQUIRED`；再次 sync 报"未登录"
3. 停掉 skybridge server，再 sync
   → 预期：`SKYBRIDGE_SERVER_UNREACHABLE`
4. 手动构造一行非法 note payload（删 `updated_at_ms`）push 到 server，让 profile B pull
   → 预期：B 端 runSync 抛错，cursor 不前进；上游错误暴露在 daemon log

### 13.6 清场

1. 在 owl 跑 `just skybridge-uninstall`
   → 预期：root `package.json` `pnpm.overrides.@skybridge/*` 清空、daemon manifest 三条依赖移除，`pnpm install` 跑完，lockfile diff 是 reverse of step §13.1
2. `just check`
   → 预期：全绿，守卫不再报错

## 14. 顺序与产出 commits（建议）

| 顺序 | 仓 | 改动 | scope |
|---|---|---|---|
| **0a** | owl | `packages/core/src/config/paths.ts` 加 `OWL_NEST_DIR` env override；测试 `nestDir() / owlDir() / configPath() / dbPath() / logDir()` 都跟随 env；保留默认 fallback `~/orpheus-aviary-nest`。预条件：profile B 隔离 | `config` |
| **0b** | owl | `permanentDeleteNote` / `batchPermanentDeleteNotes` emit 的 payload 加 `updated_at_ms: nowMs`；更新对应 emission 单测 | `notes` |
| 1 | skybridge | 三 package 加 `tsconfig.build.json` + `build` script 改 `tsc -b tsconfig.build.json` | chore |
| 2 | skybridge | 三 `scripts/gen-publishable-manifest.mjs` + `just pack-*` recipes | chore |
| 3 | skybridge | README "本地分发（dist-pack）" 章节 | docs |
| 4 | owl | `0005_sync_change_outbox.sql` + `LATEST_KNOWN_VERSION = 5` + `emitSyncChange` 返回 cid（**不**含 emit-端 validator） + note payload validator（apply 端） | `db` / `skybridge` |
| 5 | owl | core `runSync` + 结构化接口 + Fake client 单测 + `packages/core/src/index.ts` re-exports | `skybridge` |
| 6 | owl | core `skybridge/config.ts`（read/write toml） | `skybridge` |
| 7 | owl | daemon `sync/manual.ts` adapter（**非字面量** dynamic import + 本地结构化 module shape）+ `routes/sync.ts` + 单元测（沿用 `node:test`，`*.test.ts` 文件）+ e2e 测试文件 `sync.e2e.ts`（**不带** `.test.`，suite 顶层 `{ skip: !process.env.SKYBRIDGE_E2E }`，非字面量 dynamic import server）+ `package.json` 加 `test:e2e` script | `daemon` |
| 8 | owl | CLI `commands/sync.ts`（零 skybridge dep，走 daemon HTTP） + 单测 | `cli` |
| 9 | owl | `scripts/skybridge-overrides.mjs` + `scripts/skybridge-sync-once.sh` + `scripts/dev-skybridge.sh` + `scripts/check-skybridge-not-committed.sh` + `packages/core/scripts/read-daemon-port.mjs` | chore |
| 10 | owl | justfile 加 `skybridge-*` recipes + `check` 串入守卫 | chore |
| 11 | owl + skybridge + aviary | 文档统一（见 §15） | docs |
| 12 | 两仓 | 手动验收 §13；不通过回滚到上一步 | n/a |

**关键约束**：Step 0a 和 0b **必须**在 Step 4 之前完成。0a 不做 → 13.4 测不了；0b 不做 → delete payload 缺 `updated_at_ms`、validator 在 apply 端会拒绝 server 回 echo 的 delete。

不发版 / 不 tag / 不 publish。完成后两仓 `PROCESS.md` 标 "P5-a shipped (内部)"。

## 15. 文档统一

P5-a 完工时统一改这几份：

| 文件 | 改动要点 |
|---|---|
| `aviary/docs/ROADMAP.md` | 把"P5 = 0.5.0 / P6 = 1.0.0"版本绑定移除；改为按里程碑（"P5-a 内部接入 / P5-b SSE + 多 entity apply + 自动双 client 测 / P5-c 后台 + 真实双机 / P6 多设备 GA"），版本绑定推迟到全产品（owl + lark + jay）成熟 |
| `aviary/docs/SKYBRIDGE_ARCH.md` | 标 Phase 3 完成 / Phase 4 拆为 P5-a/b/c |
| `owl/PROCESS.md` | 「下一步」改成 P5-b（SSE + folder/conversation apply + 双 client 自动测试）；P5-a 进 history 段；移除 0.5.0 发版表述 |
| `owl/CLAUDE.md` | 新加 "skybridge 调试" 章节，指向 `just skybridge-*` recipes；显式说明 manifest mutation **绝不能 commit** |
| `owl/docs/plans/2026-05-07-p4-skybridge-plan.md` | 加 "Implementation record" 段（已 ship + 链到 history），并加 "Next: P5-a → 本设计文档" |
| `owl/docs/history/P5-a-shipped.md` | 完工时新建（实施记录） |
| `skybridge/PROCESS.md` | 「下一段」更新为 "owl 接入跑通后 → P5-b（SSE）"；明确"发版推迟到全产品成熟，不再是 'owl 跑通就发'" |
| `skybridge/README.md` | 加 "本地分发（dist-pack）" 章节，写 `just pack-all` → 下游 file: 安装；显式标注 `bundledDependencies` 是临时方案，npm publish 时移除 |
| `skybridge/AGENTS.md` | 若有 AI 接入指南，加一句 skybridge 调试用法（pack + override） |

## 16. 开放问题（动工时决，不影响 design 锁定）

- `owl sync login` 密码输入用 `node:readline` 隐藏模式（`rl.input.on('keypress', ...)` 自写 mask），还是用 `--password` 显式参数？倾向 readline，参考 owl CLI 现有交互模式
- `inflight` Promise dedupe 在 daemon 重启间不持久（重启即清空）；P5-a 不处理"daemon 进程崩溃中途"的恢复，靠 outbox `synced_at IS NULL` 重放
- `tsconfig.build.json` 对 skybridge 已有 `tsconfig.json` 的兼容性 —— composite + references 在 build vs IDE 用不同 file 可能引起 stale `.tsbuildinfo`，开工时 verify
- skybridge `ApiUser` 的 `email` 字段是否总在 login response 里？toml `[auth].email` 仅做展示用、缺失时 fallback 显示 `user_id`

## 17. 风险与回退

| 风险 | 触发 | 应对 |
|---|---|---|
| `bundledDependencies` 不被 pnpm 正确处理 | `pnpm add ./skybridge-client-0.1.0.tgz` 仍尝试从 npm 解析 `@skybridge/proto` | fallback：把 proto dist 也声明在 client 的 `dependencies` 里指向 file: 路径（绝对路径）。design doc 留好这条退路 |
| skybridge_config.toml 并发写竞争（daemon + CLI 同时写）| 多个 sync route 同时跑 register/ensure 阶段 | inflight Promise 已 dedupe 同进程并发；跨进程不在 P5-a 范围 |
| 守卫脚本误判（开发者临时 grep 了 `@skybridge/` 字面量到 manifest） | `just check` fail | 守卫只查 `package.json` 文件名严格匹配，不查源码；若仍误判，开发者运行 `just skybridge-uninstall` 即清 |
| schema v5 migration 在已有大量 v4 sync_changes 行的库上跑 backfill 慢 | DBA-style 担忧 | P5-a 阶段每个 owl.db 的 v4 sync_changes 行数应该 < 数千；backfill UPDATE 单事务足够快。极端情况下 forward migration runner 会 log 耗时 |
| profile B nest dir 隔离不彻底，串到 profile A | Step 0a 实现有 bug；或某条 shell script / sync 命令没 honor env | Step 0a 加单测：用 env 切换 `OWL_NEST_DIR`，断言所有 path getter 返回值都跟随；`scripts/skybridge-sync-once.sh` / `scripts/dev-skybridge.sh` 都加 `OWL_NEST_DIR` 解析；§13.4 第 9 步用 grep log 守卫 |
| 字面量 dynamic import specifier 导致 `tsc -b` 在干净 checkout 失败 | 误用 `await import('@skybridge/...')` | §8.2 / §12.2 已显式要求非字面量 specifier + 本地结构化类型；§13.1 step 1 用"干净 checkout 跑 just check"作为门控 |
| `just test` 误跑 daemon e2e 套件，干净 checkout 直接炸 | `node --test` 默认 glob 抓到 e2e | §11.4 / §12.2 用**文件名前缀** `.e2e.ts`（无 `.test.`）让 default `*.test.js` glob 不匹配；suite 顶层 `{ skip: !SKYBRIDGE_E2E }` 双保险 |
| out-of-order pull：update/trash/restore 到达时本地 note 还没被 create | 罕见但理论可能（server 单调 by serverSeq，但 client 拆分 batch / 中断重启可能） | §7.4 把这种情况显式 skip 而非报错；下一轮 pull 会带 create 上来，然后再下次 pull 会把跳过的 update 重新拉到（client cursor 是 max(server_seq)，但 server 端的 pull 通常是 `since > cursor` 所以已经处理过的事件不会重发 —— 这是 P5-a 的已知失败模式，记录到 `daemon.log`，P5-c 加 retry/conflict_record） |
| skybridge-sync-once.sh 找不到 smol-toml（root 不声明，pnpm strict hoisting） | 调试期 `just skybridge-sync-once` 报 MODULE_NOT_FOUND | §11.4 把端口解析委托给 `packages/core/scripts/read-daemon-port.mjs`，由 core 包提供 smol-toml |
| pin/reorder push 上去但 server 也不验证 payload → 远端历史里有"残缺" note 变更 | server payload 透明 | 这是有意 — P5-a 范围内 server 不验证 payload。P5-b 接 SSE 和多 entity apply 时再考虑是否冻结 server 端 payload schema |
| delete emit 缺 `updated_at_ms` 的旧 v4 数据已经在 outbox 里堆着 | Step 0b 上线前 owl 已有 v4 delete 行 | migration 0005 backfill 时同时 patch：`UPDATE sync_changes SET payload = json_object('updated_at_ms', created_at) WHERE op = 'delete' AND payload = '{}'`，把 created_at 当 fallback updated_at_ms。design doc §6.2 migration 加这一行 |
