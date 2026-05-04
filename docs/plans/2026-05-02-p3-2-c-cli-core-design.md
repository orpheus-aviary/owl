# P3.2-c CLI 核心设计

日期：2026-05-02
依赖：P3.2-a（migration runner，commit `38e9243`）、P3.2-b（GUI MigrationDialog，commit `e302838`）
上下文：`docs/plans/2026-04-20-p3-plan.md` §5

## 1. 目标与范围

交付 `apps/cli/` 可发布产物 `@orpheus-aviary/owl-cli`（bin `owl`，别名 `owl-cli`），承担纯 CLI / agent 调用场景下对 owl 数据的读写能力。

**In scope（13 个命令）**：

| 命令 | 写/读 | 说明 |
|---|---|---|
| `owl search [query]` | 读 | FTS 搜索；空 query 退化为"列最近" |
| `owl get <id>` | 读 | 完整 note JSON |
| `owl create` | 写 | 创建笔记，支持多种 input 形式 |
| `owl edit <id>` | 写 | 部分（PATCH）或整体（`--replace` → PUT）更新 |
| `owl append <id>` | 写 | 向 content 末尾追加 |
| `owl tag <id>` | 写 | 增删 tags |
| `owl delete <id>` | 写 | 移到回收站 level 1（软删）；对已 trash 的 note 拒绝（需单独 `permanent-delete`，post-P3） |
| `owl restore <id>` | 写 | 从回收站恢复到 level 0 |
| `owl trash list` | 读 | 列出回收站条目；默认 `--level 1`，`--level 2` 看"即将清除"视图 |
| `owl folders list` | 读 | 列出文件夹 |
| `owl tags list` | 读 | 列出标签 |
| `owl doctor` | 读 | 环境 / 配置 / daemon / LLM 自检 |
| `owl migrate` | 写 | 交互式 v0 → v1 rebuild |

**Out of scope**：

- `owl open`：依赖 SSE `/events` 反向通道 → 归属 P3.2-d
- 文件夹 CRUD（create/rename/move/delete）：人类用 GUI，agent 需要时再补
- 永久删除（`permanent-delete`）+ 批量操作：破坏性高，单独设计
- `owl memo` / `owl todo` / `owl remind`：GUI 的 UX 包装，CLI 不做专用命令
- `owl chat` / `owl ai` / `owl export` / `owl import`：P4+

**核心原则**：

- **输出机器优先，输入人机兼顾**：stdout 默认紧凑 JSON（稳定 schema），stderr 放进度/warning/debug；错误也是结构化 JSON
- **读 auto / 写有护栏**：读命令自动按 daemon 存活切换；写命令 daemon 跑时默认 HTTP、不跑时自动 direct（人类便利）；显式 `--direct` 遇上 daemon 在跑需 `--force`（防误写）
- **读-改-写默认 CAS**：`append` / `tag` / `edit --interactive` 自动带上刚读到的 `updated_at` 做并发检查；冲突 → `VERSION_MISMATCH`；bypass 用 `--overwrite`

## 2. 模块结构

```
apps/cli/
├── src/
│   ├── index.ts                    # commander root + 全局 options + exit code 出口
│   ├── commands/
│   │   ├── search.ts
│   │   ├── get.ts
│   │   ├── create.ts
│   │   ├── edit.ts
│   │   ├── append.ts
│   │   ├── tag.ts
│   │   ├── delete.ts
│   │   ├── restore.ts
│   │   ├── trash.ts                # owl trash list
│   │   ├── folders.ts              # owl folders list
│   │   ├── tags.ts                 # owl tags list
│   │   ├── doctor.ts
│   │   └── migrate.ts              # 特殊：不走 backend 抽象，直调 @owl/core
│   ├── backend/
│   │   ├── types.ts                # interface OwlBackend
│   │   ├── http.ts                 # HttpBackend：fetch daemon REST
│   │   ├── direct.ts               # DirectBackend：@owl/core + better-sqlite3
│   │   └── resolve.ts              # resolveBackend(opts) → {backend, mode, warnings[]}
│   ├── lib/
│   │   ├── config.ts               # 读 owl_config.toml + data_dir + daemon.port
│   │   ├── daemon-detect.ts        # HTTP /status 200ms timeout
│   │   ├── db-lock.ts              # SQLITE_BUSY 指数退避 ×3
│   │   ├── input.ts                # content 源互斥解析 + stdin auto + --data/--data-file
│   │   ├── output.ts               # writeResult / writeProgress / writeError；JSON/pretty/human 分派
│   │   ├── human-format.ts         # 每个命令的 --human 格式化器
│   │   ├── tag-strict.ts           # parseTagsStrict：输入数 ≠ 解析数则 INVALID_TAG
│   │   ├── errors.ts               # ERROR_CODES + CliError
│   │   └── exit-codes.ts           # 0/1/2/3/4/5/130
│   └── types.ts                    # 共享 Note / List / Search JSON shape
├── scripts/
│   └── gen-publishable-manifest.mjs
├── test/
│   ├── helpers/
│   │   ├── tmp-db.ts
│   │   ├── mock-backend.ts
│   │   ├── mock-fetch.ts
│   │   └── spawn-cli.ts
│   └── …（按 commands / backend / lib 组织）
├── tsup.config.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

**关键约束**：

- `commands/*.ts` 只依赖 `backend/types.ts` + `lib/*`，不直接 import `better-sqlite3` / 原生 `fetch`
- `backend/resolve.ts` 是唯一的 mode 决策点
- `commands/migrate.ts` 不走 backend 抽象，直接调 `@owl/core`
- `lib/output.ts` 三个 writer 分流 stdout / stderr

## 3. I/O 契约

### 3.1 全局 flags

**输出控制**：

| flag | 作用 | 默认 |
|---|---|---|
| `--json` | 结构化 JSON 到 stdout（默认 on，留 flag 做显式化） | on |
| `--pretty` | JSON 2-space 缩进（只对 `--json` 生效） | off |
| `--human` | 人读输出，**不保证稳定解析** | off（与 `--json` 互斥） |
| `--ndjson` | list/search 类命令每行一个 item | off |
| `--id-only` | list/search/trash list 只输出 id（每行一个，纯文本） | off |
| `--field <name>` | `get` 只输出指定字段（content/title/tags/…）；标量原文，数组 NDJSON | — |
| `--raw` | `get` 只输出 content 原文（等价 `--field content --human`） | off |
| `--no-progress` | 关闭 stderr 进度行 | off |

**模式控制**：

| flag | 作用 | 默认 |
|---|---|---|
| `--direct` | 强制 direct SQLite 模式 | off |
| `--force` | 配合 `--direct` 在 daemon 运行时仍直写（daemon 安全 bypass） | off |
| `--overwrite` | 写命令跳过 CAS（并发保护 bypass） | off |
| `--config <path>` | 覆盖 `owl_config.toml` 路径 | 默认路径 |
| `--db <path>` | 覆盖 `owl.db` 路径；**自动触发 direct 模式**；读永远允许，写 + daemon alive 需 `--force` | 从 config 解析 |

**Folder 表达 flags**（create / edit / search / trash list 等共享）：

| flag | 作用 |
|---|---|
| `--folder <id>` | 指向具体 folder |
| `--unfiled` | 等价 `folder_id = null`；与 `--folder` 互斥 |

写命令语义：`--folder` / `--unfiled` 都不给 → PATCH 模式不改 folder；`--replace` 模式必须给一个（或通过 `--data` 显式提供 `folder_id`）。读命令（search / trash list）：`--unfiled` 作为筛选条件（daemon `folder_id=null` 已支持）。

`--force`（daemon 护栏）与 `--overwrite`（CAS 护栏）**刻意分开**，避免一个"万能跳过"flag 掩盖真实风险。

### 3.2 Stdout 结果 schema

**Note JSON**（get / create / edit / append / tag / delete / restore 返回体）：

```json
{
  "id": "uuid",
  "content": "raw markdown",
  "title": "derived first non-empty line",
  "folder_id": "uuid | null",
  "tags": ["#foo", "/time:2026-05-02"],
  "trash_level": 0,
  "created_at": 1714608000000,
  "updated_at": 1714608123456,
  "auto_delete_at": null,
  "content_hash": "sha256:…"
}
```

`title` 派生自 content 首非空行。

**Search / trash list 条目 schema**（`search` / `trash list`）：

```json
{
  "total": 42,
  "items": [{
    "id": "...",
    "title": "...",
    "preview": "content 前 200 字、换行折叠成空格后截断",
    "tags": [...],
    "folder_id": "...",
    "updated_at": 1714608123456
  }],
  "limit": 20,
  "page": 1
}
```

**不再承诺 `score` / `rank` / `snippet`**。`preview` 是**展示字段**（CLI 本地计算：`content.trim().replace(/\s+/g, ' ').slice(0, 200)`），非搜索排名、非命中高亮。完整内容仍用 `owl get <id> --raw`。

**Folders list schema**：

```json
{
  "items": [
    { "id": "...", "name": "工作", "parent_id": null, "sort_order": 0 },
    ...
  ]
}
```

默认扁平；未来需要树形可加 `--tree` flag（本期不做）。

**Tags list schema**（本期**仅列 hashtag**，与现有 daemon `/tags` + `/tags/frequent` 行为对齐）：

```json
{
  "items": [
    { "value": "#foo", "type": "hashtag", "count": 42 },
    { "value": "#bar", "type": "hashtag" }
  ]
}
```

`type` 固定 `"hashtag"`。`count` 仅 `--frequent` 路径有（daemon `/tags/frequent`）；基础 `/tags` 无 count，字段省略。Post-P3.2-c 再扩展列 `/time` / `/alarm` 等其他类型（需要 core + daemon 新函数）。

**Doctor schema**：

```json
{
  "status": "ok | warn | fail",
  "checks": [
    { "name": "env.node",       "status": "ok",   "value": "v22.11.0" },
    { "name": "env.sqlite",     "status": "ok",   "value": "11.3.0" },
    { "name": "config.file",    "status": "ok",   "value": "/…/owl_config.toml" },
    { "name": "config.data_dir","status": "ok",   "value": "/…/owl" },
    { "name": "db.file",        "status": "ok",   "value": "…/owl.db", "details": { "user_version": 1 } },
    { "name": "daemon",         "status": "warn", "message": "not running", "details": { "pid_file": "…" } },
    { "name": "llm",            "status": "skipped" }
  ]
}
```

顶层聚合：任一 `fail` → `fail`；任一 `warn` 无 `fail` → `warn`；否则 `ok`。exit：ok/warn → 0；fail → 3。

**Migrate 结果 schema**：

```json
{ "success": true, "from": 0, "to": 1, "backup_path": "…/owl.db.v0.2-backup-…", "elapsed_ms": 123 }
```

若 `probeStartupState` 显示已最新：

```json
{ "success": true, "already_migrated": true }
```

### 3.3 Stderr 错误 schema

**CLI stderr 输出格式**（对外承诺）：

```json
{
  "error": {
    "code": "NOTE_NOT_FOUND",
    "message": "note abc123 not found",
    "details": { "id": "abc123" }
  }
}
```

**Daemon HTTP 响应格式**（不变，与 GUI 共用）：

```json
{ "success": false, "message": "...", "error_code": "VERSION_MISMATCH", "details": { ... } }
```

- daemon `fail()` helper 扩展第 5 参数 `details?`，**纯增量**——GUI `ApiError` 仍解析 `error_code` + `message`，不受影响
- CLI `lib/errors.ts` 的 `mapHttpError(respBody)` 把 daemon 的 `{success, message, error_code, details}` 映射到内部 `CliError(code, message, details)`，再由 `writeError` 输出为上面的 `{ error: {...} }` 形状
- 这样 daemon wire format 保持稳定，CLI 输出契约独立演进

### 3.4 Exit code 表

| code | 场景 |
|---|---|
| 0 | 成功（doctor warn 也是 0） |
| 1 | 普通失败（NOTE_NOT_FOUND / DB_BUSY / HTTP_ERROR / UNKNOWN） |
| 2 | 参数/用法错误（USAGE_ERROR / INVALID_JSON_INPUT / INVALID_TAG） |
| 3 | 配置或环境错误（CONFIG_NOT_FOUND / DATA_DIR_MISSING / ENV_UNSUPPORTED / doctor fail） |
| 4 | daemon/API 不可用（DAEMON_UNAVAILABLE，仅 HTTP 模式显式请求） |
| 5 | 冲突（DAEMON_RUNNING_BLOCKED / VERSION_MISMATCH / MIGRATION_REQUIRED / INCOMPATIBLE_DB / MIGRATION_BUSY） |
| 130 | 用户取消（SIGINT / migrate y/N 选 N） |

### 3.5 Error code 表

| code | 场景 | exit |
|---|---|---|
| `USAGE_ERROR` | commander 参数校验失败、互斥 flag 冲突、`--replace` 缺字段 | 2 |
| `INVALID_JSON_INPUT` | `--data` / `--data-file` 解析失败 | 2 |
| `INVALID_TAG` | strict tag 解析有丢弃项 | 2 |
| `CONFIG_NOT_FOUND` | `owl_config.toml` 缺失或不可读 | 3 |
| `DATA_DIR_MISSING` | 数据目录不存在 | 3 |
| `ENV_UNSUPPORTED` | Node 版本过旧 / better-sqlite3 无法加载 | 3 |
| `DAEMON_UNAVAILABLE` | HTTP 模式显式请求但 daemon 不 ready | 4 |
| `DAEMON_RUNNING_BLOCKED` | `--direct` 或 `--db` 写但 daemon 在跑且未 `--force` | 5 |
| `VERSION_MISMATCH` | CAS 失配（写期间别人动过） | 5 |
| `MIGRATION_REQUIRED` | direct 模式遇 v=0 老库 | 5 |
| `INCOMPATIBLE_DB` | v > LATEST_KNOWN_VERSION | 5 |
| `MIGRATION_BUSY` | migrate 时 daemon / 另一 CLI 持锁 | 5 |
| `NOTE_NOT_FOUND` | 目标不存在 | 1 |
| `ALREADY_TRASHED` | `owl delete` 对 `trash_level >= 1` 的 note | 1 |
| `DB_BUSY` | SQLITE_BUSY 退避 3 次仍失败 | 1 |
| `HTTP_ERROR` | daemon 返回非 2xx 且无具体映射 | 1 |
| `USER_CANCELLED` | migrate y/N 选 N 或 SIGINT | 130 |
| `UNKNOWN` | 未分类 | 1 |

### 3.6 写命令输入规则

**content 来源互斥**（commander 校验）：

- `--data <str>` / `--data-file <path>` → 完整对象；**不允许**配合 `--body` / `--file` / `--stdin` / `--tags` / `--tag` / `--folder` / `--unfiled`
- `--body <str>` / `--file <path>` / `--stdin` → content 来源；`--tags` / `--tag` / `--folder` / `--unfiled` 可补充
- 都没给 + stdin 是 TTY → `USAGE_ERROR`
- 都没给 + stdin 非 TTY（pipe） → **自动从 stdin 读 content**（等价 `--stdin`）

**Folder flag 互斥**：`--folder <id>` 与 `--unfiled` 互斥；同时出现 → `USAGE_ERROR`。

**JSON 输入对象**（create / edit `--data` payload）：

```json
{ "content": "...", "folder_id": "uuid | null", "tags": ["#foo"] }
```

**`--tags`** 语法：`--tags foo,bar,/time:2026-05-02`（CSV）或多次 `--tag v`。

**CLI 自动规范化**：裸词（不以 `#` / `/` 开头的）由 CLI 预处理成 hashtag——`foo` → `#foo`、`工作` → `#工作`——然后再喂 `@owl/core.parseTags`。这样人类和 agent 都可以直接写 `--tags 工作,项目A`，不用每次带 `#`。

**strict 校验**（`lib/tag-strict.ts`）：规范化后的输入条数 ≠ `parseTags` 成功解析的条数 → `INVALID_TAG` + `details: { bad: [...] }`。仅明显非法输入会落到 bad 列表（例如空字符串、`#` 空内容、`/unknown:xxx`）。`@owl/core.parseTags` 本体不动（agent tools 依赖宽松语义）。

### 3.7 Human 输出格式（`--human`）

不保证稳定解析，仅约定视觉规则：

| 命令 | 人读输出 |
|---|---|
| `search` / `trash list` / `folders list` / `tags list` | ASCII 表格：id 前 8 字 · title/name · tags/extra · updated_at 短格式 |
| `get` | `<title>` 单行，空行，然后 content 原文（无边框） |
| `create` / `edit` / `append` / `tag` / `delete` / `restore` | 单行：`✓ <action> <id-前8> · <title-短>` |
| `doctor` | 每 check 一行：`<glyph> <name>: <value \| message>`；最后 total：`Status: ok/warn/fail` |
| `migrate` | stderr 进度：`[<phase>] …`；最后 `✓ migrated v0 → v1 (backup: <path>)` |

`--id-only` / `--raw` / `--field` 独立于 `--human`，优先级更高（它们本身就不是 JSON 包装）。

## 4. 模式决策与并发保护

### 4.1 决策规则（`backend/resolve.ts`）

**读命令**：

```
daemon alive   → HTTP
daemon down    → direct（静默）
--direct       → direct（daemon 无论是否运行都允许，读不冲突）
--db <path>    → direct（永远允许，读另一份库无并发风险）
```

**写命令**：

```
daemon alive:
  default                → HTTP
  --direct               → require --force（否则 DAEMON_RUNNING_BLOCKED exit 5）
  --direct --force       → direct + stderr 红字警告
  --db <path>            → 视同 --direct（daemon alive → 需 --force；写另一份库仍会打扰活跃环境）

daemon down:
  default                → direct + stderr warn "daemon not running, writing direct"
  --direct               → direct（静默）
  --db <path>            → direct（静默）
  HTTP 显式请求（预留 --http flag，本期不加） → DAEMON_UNAVAILABLE exit 4
```

当前不加 `--http` flag；HTTP 是默认路径，不需要。`DAEMON_UNAVAILABLE` 保留作未来扩展出口。

### 4.2 Daemon 存活检测（`lib/daemon-detect.ts`）

- `fetch('http://127.0.0.1:<port>/status', { signal: AbortSignal.timeout(200) })`
- 200 + body `success=true` → alive；其它 → dead
- port 从 `owl_config.toml` `[daemon].port` 读，默认 `47010`，**禁止硬编码**
- PID file 不是读写命令的权威信号，仅 migrate 做第二层拒绝用

### 4.3 CAS（并发保护）

**默认启用 CAS 的命令**（读-改-写，CLI 内部先读后写）：

| 命令 | 自动行为 |
|---|---|
| `append <id>` | step 1 GET 取 `updated_at` → step 2 PATCH 带 `expected_updated_at` |
| `tag <id>` | 同上 |
| `edit <id> --interactive` | 同上（CLI 开 $EDITOR 前先 GET） |

**opt-in CAS 的命令**：

| 命令 | 行为 |
|---|---|
| `edit <id>` 非 interactive | 仅当用户显式传 `--if-updated-at <ms>` 时启用 |
| `delete <id>` / `restore <id>` | 仅当用户显式传 `--if-updated-at <ms>` 时启用 |

**Bypass**：`--overwrite` 跳过 CAS（无论默认还是 opt-in）。`--overwrite` 与 `--if-updated-at` 互斥（commander 校验）。

**`expected_updated_at` 取值优先级**（所有写命令统一，`lib/errors.ts` / 各 command 统一遵守）：

1. `--overwrite` 传了 → 不带 CAS，不发送 `expected_updated_at`
2. 否则 `--if-updated-at <ms>` 传了 → 用用户提供的值（用户/agent 显式基线胜出）
3. 否则读-改-写命令（append / tag / edit --interactive）内部 step 1 读到的 `updated_at` → 自动 CAS
4. 否则（edit 非 interactive 且没传 `--if-updated-at`；delete / restore 没传 `--if-updated-at`）→ 无 CAS

**HTTP 层**：daemon `PATCH /notes/:id` + `PUT /notes/:id` 接受可选 body `expected_updated_at: number`，失配 → 409 + `{ success: false, message, error_code: "VERSION_MISMATCH", details: { expected, current } }`（daemon 现有 wire format，参见 §3.3）。`POST /notes/:id/restore` + `DELETE /notes/:id` 同理。

**Direct 层**：`@owl/core.updateNote` 新增 `expectedUpdatedAt?: number`，BEGIN IMMEDIATE 内 SELECT + 比对 + UPDATE；失配抛 `VersionMismatchError`（新导出）。restore / delete 也需要相应支持（`restoreNote` / `deleteNote` 各加一个参数，或单独 wrapper）。

### 4.4 SQLITE_BUSY 退避（direct 写）

- `createDatabase` 已设 `busy_timeout = 5000` 吸收瞬时竞争
- `lib/db-lock.ts` 的 `withRetry<T>(fn, label)`：捕获 `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` 重试 3 次，指数退避 50ms / 150ms / 400ms
- 失败 → `DB_BUSY`（exit 1，`details.retries=3`）
- 仅写命令 wrap

### 4.5 migrate 的三层拒绝

1. `daemon-detect` `/status` 200 → `MIGRATION_BUSY { reason: "daemon-http-alive" }`
2. daemon.pid 文件存在且 `process.kill(pid, 0)` 为真 → `MIGRATION_BUSY { reason: "daemon-pid-alive" }`
3. `@owl/core.migrateLegacyDb` 自带的 `lock_file` 兜底

任一命中 → exit 5。

### 4.6 Stdout / stderr 分流

| 流 | 写什么 |
|---|---|
| stdout | 最终结果（JSON / --raw 内容 / --field / --id-only 行流） |
| stderr | 进度行（migrate 4 phase、direct 写 warn、`--force` 警告）、错误 JSON |

`--no-progress` 关闭 stderr 进度流（错误仍输出）。

## 5. 各命令行为细节

### 5.1 `owl search [query]`

- query 可选：省略时退化为"列最近"（按 `updated_at desc`）
- flags：`--limit <n>`（默认 20）、`--page <n>`（默认 1，daemon 原生 page 语义）、`--folder <id>` / `--unfiled`、`--tag <v>`（可多次）、`--no-include-descendants`、`--sort-by updated|created`、`--sort-order asc|desc`、`--id-only`
- `backend.searchNotes({ q, limit, page, folderId, tags, sortBy, sortOrder, includeDescendants })`
- HTTP：`GET /notes?q=…&page=…&limit=…&folder_id=…&tags=…`
- direct：**用 `listNotes`（带或不带 q 都走同一路径）**，**不要** `searchNotesWithDetails`——后者只支持 `query + limit`，缺 page/folder/tags/sort/includeDescendants，行为会和 HTTP 不一致
- preview 由 CLI 本地计算（§3.2）
- stdout：`{ total, items:[…], limit, page }`

### 5.2 `owl get <id>`

- flags：`--field <name>`、`--raw`
- `backend.getNote(id)`
- 404 → `NOTE_NOT_FOUND`
- stdout：
  - 默认：完整 Note JSON
  - `--field content`：content 原文（stdout 直输，换行保留，无 quote）
  - `--field tags`：NDJSON，每行一个 tag
  - `--raw`：等价 `--field content`

### 5.3 `owl create`

- flags：`--body` / `--file` / `--stdin` / `--data` / `--data-file`（content 源互斥，见 §3.6）；`--tags` / `--tag`（可多次）、`--folder <id>` / `--unfiled`（后二者互斥）
- 输入解析按 §3.6 规则（含 stdin auto）
- 预处理：`content.trimEnd() + '\n'`；tags 走 `parseTagsStrict`
- `backend.createNote({ content, folderId, tags })`
- HTTP：`POST /notes`；direct：`createNote(db, sqlite, input)` + `ensureDeviceId`
- stdout：完整 Note JSON

### 5.4 `owl edit <id>`

- flags：
  - content 输入：`--body` / `--file` / `--stdin` / `--data` / `--data-file`（互斥，见 §3.6）
  - 元数据：`--tags` / `--tag`、`--folder <id>` / `--unfiled`（folder 二者互斥）
  - 语义：`--replace`（PUT）、`--interactive`（开 $EDITOR）
  - 并发：`--if-updated-at <ms>`、`--overwrite`
- 解析：
  - `--interactive`（独占）→ `backend.getNote(id)` → 临时文件写 content → `spawn($EDITOR, tmp, inherit)` → 读回 → PATCH **默认 CAS**（用 step 1 的 `updated_at`）
  - 非 interactive 非 replace → PATCH 部分更新；`--if-updated-at` 才 CAS
  - `--replace` → PUT **严格**：必须同时提供 content + tags + folder 三者（folder 可用 `--folder <id>` 或 `--unfiled` 显式 null；三者也可走 `--data`）；缺任一 → `USAGE_ERROR`
- **需要后端改动**：
  - daemon `PUT /notes/:id`：改为严格 replace，body 必须含 `content` + `tags` + `folder_id`，缺任一 400；支持 `expected_updated_at`
  - daemon `PATCH /notes/:id`：支持 `expected_updated_at`
  - `@owl/core.updateNote`：支持 `expectedUpdatedAt` + `VersionMismatchError`
- stdout：更新后的 Note JSON

### 5.5 `owl append <id>`

- flags：`--body <str>` / `--stdin`（互斥）、`--separator <str>`（默认 `\n\n`）、`--no-newline`、`--overwrite`、`--if-updated-at <ms>`
- 行为：
  1. `backend.getNote(id)` 读当前 content + `updated_at`
  2. 计算 newContent：
     - `--no-newline` → `current + appendText`
     - 否则 → current 末尾非换行时插 `separator`
  3. 按 §4.3 优先级决定 `expected_updated_at`：`--overwrite` → 无；否则 `--if-updated-at` → 用用户值；否则 → 用 step 1 读到的 `updated_at`
  4. `backend.patchNote(id, { content: newContent }, { expectedUpdatedAt? })`
- 冲突（VERSION_MISMATCH） → 提示 agent 重跑

### 5.6 `owl tag <id>`

- flags：`--add <v>`（可多次）、`--remove <v>`（可多次）、`--overwrite`、`--if-updated-at <ms>`
- 行为：
  1. `backend.getNote(id)` 读当前 tags + `updated_at`
  2. `newTags = (current − remove) ∪ add`，经 `parseTagsStrict` 校验（含 bare→`#` 规范化）
  3. 按 §4.3 优先级决定 `expected_updated_at`（同 append）
  4. `backend.patchNote(id, { tags: newTags }, { expectedUpdatedAt? })`

### 5.7 `owl delete <id>`

- flags：`--if-updated-at`、`--overwrite`
- 语义固定：**仅 level 0 → level 1**。CLI 不暴露 level 1 → level 2 的"即将清除"升级路径（那是 GUI TrashPage 的职责；post-P3 的 `owl permanent-delete` 才会做）
- 预检查（便于给用户清晰错误，非权威）：`backend.getNote(id)` 若 `trash_level >= 1` → `ALREADY_TRASHED` exit 1（`details: { id, current_trash_level }`）
- HTTP：`DELETE /notes/:id`，body/query 带 `reject_if_trashed: true`（CLI 专用显式选项）+ 可选 `expected_updated_at`
- direct：`deleteNote(db, sqlite, id, { expectedUpdatedAt?, rejectIfTrashed: true, autoDeleteDays: config.trash.auto_delete_days })`（`autoDeleteDays` 传但不会用到，保持签名一致）
- 权威拦截：core 层当 `rejectIfTrashed=true` 且当前 `trash_level >= 1` → 抛 `AlreadyTrashedError`；**默认（GUI / AI tools 调用）行为不变**，保持 level 1→2 升级语义
- 返回：daemon / core 统一返回更新后的 Note（trash_level=1，`auto_delete_at=NULL`）
- stdout：更新后的 Note JSON

### 5.8 `owl restore <id>`

- flags：`--if-updated-at`、`--overwrite`
- HTTP：`POST /notes/:id/restore`（支持 `expected_updated_at`）
- direct：`restoreNote(db, sqlite, id, { expectedUpdatedAt? })`
- 返回：daemon / core 统一返回更新后的 Note（trash_level=0）
- stdout：更新后的 Note JSON

### 5.9 `owl trash list`

- flags：`--level <1|2>`（默认 1）、`--limit`、`--page`、`--id-only`
- HTTP：`GET /notes?trash_level=<level>&page=…&limit=…`
- direct：`listNotes({ trashLevel: level, ... })`
- stdout：与 search 同 schema（含 preview）
- 本期不提供 `--level all`（需要扩 daemon `trash_level` 参数接受 CSV 或 CLI 发两次请求合并），留给 post-P3.2-c

### 5.10 `owl folders list`

- flags：`--id-only`
- HTTP：`GET /folders`
- direct：`listFolders(db)`
- stdout：`{ items: [{ id, name, parent_id, sort_order }, ...] }`

### 5.11 `owl tags list`

- 本期**仅列 hashtag**
- flags：`--frequent`（返回带 count）、`--value-only`（每行一个 tag value，纯文本）
- HTTP：`GET /tags`（无 count）或 `GET /tags/frequent`（带 count）
- direct：调 `@owl/core.listHashtagTags({ frequent?, limit? })`（**新增 core helper**，见 §8）
- stdout：`{ items: [{ value, type: "hashtag", count? }, ...] }`

### 5.12 `owl doctor`

- flags：`--llm`（只跑 LLM）、`--all`（env + config + daemon + LLM 全跑）
- 默认：env / config / daemon
- 检查项：
  - `env.node` — `process.version` vs `engines.node`（≥22）
  - `env.sqlite` — `require('better-sqlite3')` + 版本
  - `config.file` / `config.data_dir` — `@owl/core.loadConfig` + `paths`
  - `db.file` — 存在性 + 只读 `probeStartupState` 读 `user_version`
  - `daemon` — `daemon-detect` + pid 文件（未跑 = warn）
  - `llm`（`--llm` / `--all`）— daemon up 走 `POST /llm/test`；否则 direct ping 配置 base_url；无 key → `skipped`
- 顶层 `status` 按 §3.2 聚合

### 5.13 `owl migrate`

- flags：`--yes` / `-y`（跳过 prompt，非 TTY 必须）、`--db <path>`、`--no-progress`
- **不暴露 `--backup-dir`**（core `MigrateOptions` 目前不支持，未来扩展再加）
- 流程：
  1. `probeStartupState(dbPath)` 
     - `v === LATEST` → stdout `{ success: true, already_migrated: true }` exit 0
     - `v > LATEST` → `INCOMPATIBLE_DB` exit 5
  2. §4.5 三层 daemon 拒绝
  3. TTY 且无 `--yes` → 打印 "将迁移 <path>（备份到 <path>.v0.2-backup-<ts>），继续？ [y/N]" 读 stdin；选 N → `USER_CANCELLED` exit 130
  4. `migrateLegacyDb(dbPath, { onProgress })`：每 phase → stderr `{ "phase": "backup|copy|fts-rebuild|swap", "ts": <ms> }`
  5. 完成 → stdout `{ success, from, to, backup_path, elapsed_ms }` exit 0

不走 backend 抽象。

## 6. 测试策略

### 6.1 分层

| 层 | 测什么 | 工具 | 量级 |
|---|---|---|---|
| **Unit** | `input.ts` 互斥+stdin auto、`output.ts` 格式化、`errors.ts` code→exit、`tag-strict.ts` 丢弃检测、`human-format.ts` 表格、preview 计算、append newline、daemon-detect timeout | vitest + `vi.useFakeTimers` | ~30 条 |
| **Contract（主力）** | 每命令 2 条：(a) DirectBackend + 真 tmp sqlite；(b) HttpBackend + mock fetch 断言 URL/method/body | vitest + `@owl/core` + `global.fetch = vi.fn()` | 13 × 2 = ~26 条 |
| **Smoke E2E** | spawn 真 `dist/index.js`：(a) 无 daemon 链路 `create → get → search → edit → append → tag → delete → restore → migrate`；(b) HTTP 链路相同流水；(c) CAS 冲突路径 | vitest + `execFile` | ~4-5 条 |

### 6.2 测试基础设施

- `test/helpers/tmp-db.ts`：`createTmpDb()` 返回 `{ dbPath, sqlite, db, cleanup }`，内部 `createDatabase` + `ensureSpecialNotes` + `ensureDeviceId`
- `test/helpers/mock-backend.ts`：`createMockBackend()` 返回带 `vi.fn` spies 的 backend
- `test/helpers/mock-fetch.ts`：`mockFetchResponse({ status, body })` + `getLastRequest()`
- `test/helpers/spawn-cli.ts`：`spawnCli(args, { env?, stdin? })` → `{ stdout, stderr, exitCode }`

### 6.3 跨包测试归属

- daemon `PUT /notes/:id` 严格化 + `expected_updated_at` 支持 → `packages/daemon/src/routes/notes.test.ts`
- daemon `PATCH` / `DELETE` / `POST /restore` 的 `expected_updated_at` → 同上
- `@owl/core.updateNote` / `deleteNote` / `restoreNote` 的 `expectedUpdatedAt` + `VersionMismatchError` → `packages/core/src/notes/notes.test.ts`

CLI 这边只验证：CAS 命令默认带上 `expected_updated_at`；`--overwrite` 跳过；收 409 / `VersionMismatchError` → exit 5 + 正确 JSON。

### 6.4 CI gate

- `pnpm -r run test`：自动纳入 cli 新测试
- `pnpm run lint`：biome 自动扫
- `pnpm run typecheck`：根 `tsconfig.json` `references` 加 `apps/cli/tsconfig.json`

## 7. 构建与发布

### 7.1 tsup（`apps/cli/tsup.config.ts`）

```ts
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  bundle: true,
  noExternal: ['@owl/core'],
  external: [
    'better-sqlite3',
    'drizzle-orm',
    'commander',
    'pino', 'pino-roll',
    'smol-toml',
    'uuid',
  ],
  sourcemap: true,
  clean: true,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
  outDir: 'dist',
  onSuccess: 'node scripts/gen-publishable-manifest.mjs',
});
```

`0001_initial.sql` 需要随 bundle 进 dist；`gen-publishable-manifest.mjs` 负责 copy。

### 7.2 发布 manifest（`scripts/gen-publishable-manifest.mjs`）

build 后生成 `dist/package.json`：

```json
{
  "name": "@orpheus-aviary/owl-cli",
  "version": "<apps/cli/package.json 的 version>",
  "type": "module",
  "bin": { "owl": "index.js", "owl-cli": "index.js" },
  "files": ["index.js", "index.js.map", "README.md", "LICENSE", "migrations/*.sql"],
  "engines": { "node": ">=22.0.0" },
  "dependencies": {
    "better-sqlite3": "<从 pnpm-lock.yaml 解析>",
    "drizzle-orm": "...",
    "commander": "...",
    "pino": "...",
    "pino-roll": "...",
    "smol-toml": "...",
    "uuid": "..."
  },
  "repository": "https://github.com/orpheus-aviary/owl",
  "license": "MIT"
}
```

版本从 `pnpm-lock.yaml` 解析，保证与本地锁定一致。README / LICENSE / migrations SQL 一并 copy。仓库根若缺 LICENSE → 本次补 MIT。

### 7.3 命令

```bash
pnpm --filter @owl/cli build           # tsup + gen manifest + copy assets
pnpm --filter @owl/cli test

# 发布（P3.3 前不跑）
pnpm --filter @owl/cli build
cd apps/cli/dist
pnpm publish --access public --no-git-checks
```

`justfile` 新增：

```
cli-build:
    pnpm --filter @owl/cli build

cli-smoke: cli-build
    node apps/cli/dist/index.js --help
    node apps/cli/dist/index.js doctor
```

### 7.4 workspace manifest（`apps/cli/package.json`）

```json
{
  "name": "@owl/cli",
  "version": "0.3.0-dev",
  "private": true,
  "type": "module",
  "bin": { "owl-cli": "dist/index.js" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@owl/core": "workspace:*",
    "commander": "^13.1.0",
    "better-sqlite3": "...",
    "drizzle-orm": "...",
    "pino": "...",
    "pino-roll": "...",
    "smol-toml": "...",
    "uuid": "..."
  },
  "devDependencies": {
    "tsup": "^8.3.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0",
    "@types/node": "^25.5.2",
    "typescript": "^5.7.0"
  }
}
```

workspace `bin` 只保留 `owl-cli`，避免开发期污染全局 `owl`；发布 manifest 才同时暴露两者。

### 7.5 风险与缓解

| 风险 | 缓解 |
|---|---|
| better-sqlite3 非 LTS Node 落到本地编译 | `owl doctor` 专项检查 + 引导 Node 22/24 LTS |
| publishable manifest 与 lockfile 偏差 | 脚本从 `pnpm-lock.yaml` 读 + P3.3 checklist 跑 `npm pack && npm i -g <tarball>` smoke |
| tsup 漏打 `0001_initial.sql` | `onSuccess` 跑 gen manifest + copy SQL；smoke test `owl migrate` 覆盖 |
| daemon PUT 严格化破坏 GUI 现有调用 | 搜索 GUI 侧 `PUT /notes/:id` 调用点，先适配后再合 daemon 改动（见 §8） |

## 8. 依赖改动清单

**`@owl/core`**：

- 新增导出 `VersionMismatchError` 类
- 新增导出 `AlreadyTrashedError` 类
- `updateNote(db, sqlite, id, input, opts?)`：新增 `opts.expectedUpdatedAt?: number`；失配抛 `VersionMismatchError`；返回类型维持 `NoteWithTags | null`
- `deleteNote(db, sqlite, id, opts?)`：
  - 新增 `opts.expectedUpdatedAt?: number`
  - 新增 `opts.rejectIfTrashed?: boolean`（默认 `false`，**保留现有 level 1→2 升级语义**，TrashPage / batchDeleteNotes / AI tools 行为不变）
  - **保留 `opts.autoDeleteDays?: number`**（或维持既有签名字段）：仅在 level 1→2 升级时使用，用来 stamp `auto_delete_at = now + days * 86400_000`。daemon / GUI 路径继续从 `ctx.config.trash.auto_delete_days` 取值后传入；CLI 路径也把配置值传进来（`rejectIfTrashed=true` + level 0→1 不会触发 stamp，传进来只是保持签名一致）
  - 返回类型从 `boolean` 改为 `NoteWithTags | null`（null = not found；失配抛 `VersionMismatchError`）
  - 当 `rejectIfTrashed=true` 且当前 `trash_level >= 1` → 抛 `AlreadyTrashedError`（仅 CLI 调用链路会传）
  - `auto_delete_at`：level 0→1 写 NULL（不变）；level 1→2 按 `autoDeleteDays` stamp（不变）
- `restoreNote(db, sqlite, id, opts?)`：
  - 新增 `opts.expectedUpdatedAt?: number`
  - 返回类型从 `boolean` 改为 `NoteWithTags | null`
- **新增 `listHashtagTags(db, sqlite, opts?)` helper**（`packages/core/src/tags/`）：
  - 签名：`listHashtagTags(db, sqlite, { frequent?: boolean, limit?: number }): Array<{ value: string, count?: number }>`
  - `frequent=true` 时按出现次数 desc 排序并带 `count`（从 `note_tags` 聚合 + JOIN `notes` 过滤 `trash_level=0`）
  - `frequent=false` 时按 `value` asc，不带 count（更便宜）
  - **WHERE `tag_type='#'`**（core 的 `TAG_TYPES` 用 `'#'` 字面量，不是 `'hashtag'`；参见 `packages/core/src/tags/parser.ts`）
  - CLI 输出层 `type` 字段映射为 `"hashtag"` 字符串（更直观的对外名字，不泄露 DB 内部符号）
  - 复用 daemon 现有 `/tags` + `/tags/frequent` 的聚合逻辑——把 daemon `packages/daemon/src/routes/tags.ts` 的 tag 聚合查询下沉到 core，daemon 改为调 helper；GUI / AI tools 不受影响（都走 HTTP）
- 新测试：`notes.test.ts` 加约 14 条
  - `updateNote` 匹配 / 失配 / no-change（2 条）
  - `deleteNote` level 0→1 return-note / level 1→2 仍可升级（回归保障） / `rejectIfTrashed=true` 对 level 1 抛 AlreadyTrashedError / 失配 / 未找到 / auto_delete_at=NULL（level 1）断言（7 条）
  - `restoreNote` 匹配 / 失配 / 未找到 / return-note 断言（4 条）
- 新测试：`tags/list.test.ts`（新文件）加约 4 条：frequent on/off × 基础 + trash 过滤回归
- 现有调用点回归：`packages/core/src/**` 所有 `deleteNote` / `restoreNote` 布尔分支改成 `!== null` 判断；**不传 `rejectIfTrashed` 即保留原行为**，AI tools / GUI 侧无需改调用

**`packages/daemon`**：

- `fail()` helper（`packages/daemon/src/response.ts`）扩展签名：`fail(reply, status, message, error_code?, details?)` → response 加可选 `details` 字段；GUI `ApiError` 只读 `error_code` + `message`，纯增量不破坏
- `PUT /notes/:id`：**严格 replace**。body 必须含 `content` + `tags` + `folder_id`；缺任一 → 400 + `error_code: USAGE_ERROR`。支持 `expected_updated_at`；失配 → 409 + `error_code: VERSION_MISMATCH` + `details: { expected, current }`
- `PATCH /notes/:id`：支持可选 `expected_updated_at`；失配 → 409 + VERSION_MISMATCH
- `DELETE /notes/:id`：
  - 支持可选 body `expected_updated_at` + 可选 body `reject_if_trashed: boolean`（默认 false，保留现有 level 1→2 升级语义）
  - 透传给 core `deleteNote(...)` 的 opts
  - catch core `AlreadyTrashedError`（仅 `reject_if_trashed=true` 路径可能抛） → 409 + `error_code: ALREADY_TRASHED` + `details: { current_trash_level }`
  - catch `VersionMismatchError` → 409 + VERSION_MISMATCH
  - 从 `ok(reply, null)` 改为 `ok(reply, note)`；**GUI 现有调用无需改动**（不传 reject_if_trashed 即维持原语义；多出来的 data 是增量）
- `POST /notes/:id/restore`：支持可选 body `expected_updated_at`；从 `ok(reply, null)` 改为 `ok(reply, note)`；失配 → 409
- 新测试：`notes.test.ts` 加约 12 条（4 路由 × 匹配 + 失配 + return-note 断言 + DELETE 对已 trash note 返 ALREADY_TRASHED）

**GUI 侧适配**（因 daemon 签名变化）：

- **daemon PUT 严格化**：grep `packages/gui/src/renderer/src/lib/api.ts` + `stores/` + `components/` 所有 `PUT /notes/:id` 调用点，当前可能只传 `content`（未传 tags/folder）→ 会 400。需要改成：要么改走 PATCH；要么 caller 补齐三字段
- **delete/restore 返回变化**：grep GUI 使用 `apiDelete('/notes/:id')` / `apiPost('/notes/:id/restore')` 的地方，确认**没有代码依赖 `data === null`**。典型场景只关心 `success`，兼容；若有本地 store 需要更新的场景，新 response 的 `data: note` 反而更好用
- **delete 语义保持**：GUI **不传** `reject_if_trashed`，TrashPage tab 1 的 level 1→2 升级 / batchDeleteNotes 批量升级路径**继续可用**。CLI 的安全护栏通过 `reject_if_trashed: true` opt-in，不污染 GUI 路径
- GUI 现有测试套件必须继续通过

**根 / justfile**：

- `tsconfig.json` references 加 `apps/cli`
- `justfile` 加 `cli-build` / `cli-smoke`
- 仓库根补 `LICENSE`（MIT）

**`apps/cli`**：

- 全部新代码 + 测试（§ 2 + § 6）
- workspace `bin` 保留 `owl-cli`
- 新增 devDeps：`tsup` / `tsx` / `vitest`
- 新增 runtime deps：`better-sqlite3` / `drizzle-orm` / `pino` / `pino-roll` / `smol-toml` / `uuid`

## 9. 验收标准

- `just check`（lint + typecheck）通过
- `just test` 全仓通过，新测试：core +18（notes 14 + tags 4）/ daemon +12 / cli ≈ 60（unit 30 + contract 26 + smoke 4-5）
- `pnpm --filter @owl/cli build` 出 `dist/index.js` + `dist/package.json` + `dist/migrations/*.sql`
- 手动 smoke：
  - `node apps/cli/dist/index.js doctor` 输出结构化 JSON，各 check 项正确
  - 本地起 daemon + `owl create` → `owl get` → `owl search` → `owl edit` → CAS 冲突 → `owl append` / `tag` / `delete` / `restore`
  - 停 daemon + 同上（direct 路径）
  - `--direct` + daemon up → `DAEMON_RUNNING_BLOCKED`；加 `--force` → direct + stderr 警告
  - `--overwrite` 跳过 CAS
  - `owl folders list` / `owl tags list` / `owl trash list`
  - 管道：`owl search --id-only | xargs -I{} owl get {} --raw`
  - stdin auto：`echo "hi" | owl create`
  - 临时库走 `owl migrate` v0 → v1 链路
- `npm pack dist/` + `npm i -g <tarball>` + `owl --help` / `owl doctor` 正常（publish 前最后一步）

## 10. Post-P3.2-c 待做（不归本子提交）

- P3.2-d：`owl open <id>` + daemon SSE `/events` 反向通道
- `owl permanent-delete <id>`（level 1 → 2 或直删） + `owl trash list --level all`
- `owl export` / `owl import`（批量备份恢复，复用 `backupDatabase`）
- `owl folders` CRUD（create/rename/move/delete）
- `owl batch-*`（批量软删 / 恢复）
- `owl reminders list / upcoming / alarms`
- `owl tags list` 扩展列 `/time` / `/alarm` 等类型 + counts（需要先扩 core + daemon）
- CLI `snippet()` FTS 封装（依赖 core 新 search API）
- `--diff`（edit 前显示差异）
- **`owl skill export <path>`**：导出 agent 用的 `skill.md`（描述 CLI 命令表、JSON schema、常见用法、CAS/exit code 指引），供 Claude / 其他 agent 直接 load。主体功能定稳后再做
- GUI installer 内置 CLI（post-P3）
- `owl doctor --recover`（migrate 残局恢复）
- macOS universal / Windows / Linux CI matrix

---

**参考文档**：

- `docs/plans/2026-04-20-p3-plan.md` §5（P3.2 主计划）
- `docs/plans/2026-04-29-p3-2-a-migration-runner-design.md`
- `docs/plans/2026-04-30-p3-2-b-migration-dialog-design.md`
- `PROCESS.md` P3.2-a / P3.2-b 实施详情

---

## Implementation record（2026-05-02 shipped，9 commits `10b8bd5`..`7732efc`）

基线：271/271（P3.2-b 后）。
完成时：**404/404 测试**（core 128 + daemon 110 + gui 68 + cli 98）。

### 9 phase commit 表

| Phase | Commit | 范围 | 测试增量 |
|---|---|---|---|
| P1 | `10b8bd5` | core CAS + AlreadyTrashedError + listHashtagTags + sqlite param for delete/restore | core +20 |
| P2 | `e57cc13` | daemon PUT 严格 + PATCH/DELETE/restore expected_updated_at + DELETE reject_if_trashed + return-note + fail(details) | daemon +15 |
| P3 | `e603cb4` | GUI: editor-store branch 3 + editTagOnNote 从 PUT 迁 PATCH；api.updateNote 删除；api.delete/restore 返回类型 Note | gui ±0 |
| P4 | `8881b94` | `apps/cli` scaffold: deps + vitest + LICENSE（tsup / manifest / justfile 延后 P8） | — |
| P5 | `e899cf8` | CLI lib: exit-codes / errors / output / tag-strict / input / daemon-detect / db-lock / config | cli +57 |
| P6 | `4d5f142` | backend 抽象: types / http (fetch mock) / direct (@owl/core) / resolve (§4.1 决策矩阵) | cli +35 |
| P7 | `591c8b4` | 13 commands + commander root + context + serializer | cli +6 |
| P8 | `63a0d0b` | tsup bundle + scripts/gen-publishable-manifest.mjs + justfile cli-smoke + README | — |
| P9 | `7732efc` | verification + global flag merge fix（`--id-only` / `--pretty` / `--ndjson` 通过 `cmd.optsWithGlobals()` + Object.assign 送到子命令 handler） | — |

### 关键设计决策兑现

- **CAS via `sqlite.transaction().immediate()`**（§4.3）：core updateNote/deleteNote/restoreNote 包裹 IMMEDIATE 事务做 SELECT + 比对 + UPDATE；并发写不会在 SELECT 和 UPDATE 之间插入
- **reject_if_trashed 默认 false**（§5.7）：GUI TrashPage / batchDeleteNotes / AI tools 的 level 1→2 升级路径不受影响；CLI opt-in 抛 AlreadyTrashedError
- **PUT 严格化 = 全替换三元组**（§5.4）：content + tags + folder_id 缺一即 400 USAGE_ERROR；GUI editor-store 从 PUT 迁 PATCH 避免炸
- **fail(details) 纯增量**（§3.3）：GUI ApiError 只读 error_code + message；daemon wire 多出的 details 字段对旧消费者透明
- **listHashtagTags 下沉 core 但 daemon /tags 路由 wire 不变**（§8 偏差）：GUI Tag / FrequentTag shape（id + tagType + tagValue + usage_count）保持；CLI HttpBackend 在反序列化时 re-shape 成 `{value, count?}`；CLI DirectBackend 直接调 `listHashtagTags`
- **backend 抽象的 9 方法接口**（§2）：commands/ 只依赖 `OwlBackend` + lib/*，不直接 import better-sqlite3 / fetch
- **stdout 紧凑 JSON 默认 + stderr 进度/错误**（§3.1、§4.6）：serialize.ts 统一 snake_case + ms timestamps + 派生 title + sigil-prefix tag 字符串
- **模式决策分 read/write**（§4.1）：decideMode 纯函数 11 测试全覆盖；daemon alive + --direct 写入需 --force 否则 DAEMON_RUNNING_BLOCKED
- **publishable 独立于 workspace**（§7.2）：workspace `@owl/cli` private；`dist/package.json` 写 `@orpheus-aviary/owl-cli` + bin `owl` / `owl-cli`；copy LICENSE + 0001_initial.sql

### 手动 smoke（HTTP + direct 双路径）

- `owl doctor` → status=ok（env.node v24.13.0 + env.sqlite 3.49.2 + config + db user_version=1 + daemon alive）
- `owl create --stdin --tag x` + `owl get --field title` + `owl append --body` + `owl tag --add --remove` + `owl delete` + `owl restore` 全流程
- `owl delete` 已 trash 的 note → 409 ALREADY_TRASHED + details.current_trash_level
- `owl edit --if-updated-at 1` → 409 VERSION_MISMATCH + details.expected/current
- `owl search --limit 3 --id-only` → 纯 ID 流
- `owl tags list --frequent --limit 3 --pretty` → 按 count desc 的 `{value: "#x", type: "hashtag", count: n}` 列表

### 产物验证

- `pnpm run lint`：零错误，16 warnings（+3 新：cli edit / migrate / http cognitive complexity，P1 基线 13）
- `pnpm --filter @owl/cli run build` → `dist/index.js` (87KB) + `dist/package.json` + `dist/migrations/0001_initial.sql` + `dist/LICENSE`
- `just cli-smoke` 通过

### 偏差 / 延后

- `--human` 输出格式器 → 未实现（设计 §3.7 明确"不保证稳定解析"，为 post-P3.2-c 的可选增强）
- `owl open` → P3.2-d（需要 SSE reverse channel）
- `owl permanent-delete` + `owl trash list --level all` + `owl folders` CRUD → P6（破坏性 + 低频）
- `owl doctor --llm` 只标 skipped（daemon /llm/test 的 LLM 探活路径留给后续）
- `ensure-node-abi` justfile 只 rebuild `.pnpm/better-sqlite3` 不 rebuild hoisted `node_modules/better-sqlite3`（`.npmrc: node-linker=hoisted` 导致两份） → 不是 P3.2-c 范围，遇到再处理
