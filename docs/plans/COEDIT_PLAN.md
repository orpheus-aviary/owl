# owl + migration 重构计划

> owl Go → TypeScript 重写 + migration TS 实现

## 1. 技术栈（已确定）

### owl

| 模块 | 选型 |
|------|------|
| 桌面框架 | Electron + Node.js |
| 构建工具 | electron-vite + Vite |
| 包管理 | pnpm workspace（后续可扩展 turborepo） |
| 数据库 | better-sqlite3 + drizzle-orm + FTS5 |
| HTTP server | Fastify |
| 前端框架 | React + TypeScript |
| 组件库 | shadcn/ui + Tailwind CSS |
| 图标 | lucide-react |
| Markdown 编辑器 | CodeMirror 6 |
| Markdown 渲染 | react-markdown + remark-gfm + rehype-katex + rehype-highlight |
| 状态管理 | zustand |
| 路由 | react-router |
| CLI 框架 | commander |
| 日志 | pino + pino-roll（日志轮转） |
| 配置 | smol-toml（保持 owl_config.toml 格式兼容） |
| 系统通知 | Electron Notification API（GUI）/ node-notifier（daemon） |
| Lint + Format | Biome |
| 类型检查 | tsc --noEmit |
| 单二进制打包（CLI） | pkg |

### migration

| 模块 | 选型 |
|------|------|
| 语言 | TypeScript（Node.js） |
| HTTP server | Fastify |
| 实时通信 | WebSocket（@fastify/websocket） |
| 文件监控 | chokidar |
| CLI 框架 | commander |
| 日志 | pino |
| 配置 | smol-toml |
| 打包 | pkg（单二进制，win/mac/linux） |

## 2. Monorepo 结构（已确定）

```
owl/
├── pnpm-workspace.yaml
├── package.json
├── biome.json
├── tsconfig.base.json
│
├── packages/
│   ├── core/                       # @owl/core
│   │   └── src/
│   │       ├── db/                 # drizzle schema + migrations + 查询
│   │       ├── config/             # TOML 配置读写
│   │       ├── tags/               # 标签解析
│   │       ├── notes/              # 笔记 CRUD 业务逻辑
│   │       ├── search/             # FTS5 搜索
│   │       ├── ai/                 # LLM 客户端 + tool calling
│   │       └── logger/             # pino 日志封装
│   │
│   ├── daemon/                     # @owl/daemon
│   │   └── src/
│   │       ├── server.ts           # Fastify 路由注册
│   │       ├── routes/             # notes、tags、reminders、ai、system
│   │       ├── scheduler.ts        # 提醒/过期轮询 + 定时器
│   │       ├── notify.ts           # 系统通知
│   │       └── cli.ts              # commander 入口
│   │
│   └── gui/                        # @owl/gui
│       └── src/
│           ├── main/               # Electron 主进程
│           ├── preload/            # preload 脚本
│           └── renderer/           # React 前端
│               ├── pages/          # 编辑、浏览、回收站、提醒、AI、待办、设置
│               ├── components/
│               ├── stores/         # zustand
│               ├── hooks/
│               └── lib/
│
├── apps/
│   └── cli/                        # @owl/cli — 外部 agent 调用入口
│       └── src/
│           ├── commands/           # search、get、create、edit、memo、todo、remind
│           └── index.ts            # daemon 检测 + 智能切换
│
└── CLAUDE.md
```

### 模块依赖

```
@owl/cli ──→ @owl/core（直连 DB，短事务）
                 ↑        若 daemon 运行则走 HTTP
@owl/daemon ─→ @owl/core
                 ↑
@owl/gui ────→ @owl/daemon（renderer 仅通过 HTTP API）
             → @owl/core（main 进程 + 类型导入）
```

### CLI 智能切换策略

- 检测 daemon 是否运行（HTTP 心跳 `/status`）
- daemon 运行 → 走 HTTP API
- daemon 未运行 → 直连 better-sqlite3（WAL 模式，避免长事务）

## 3. 数据目录（已确定）

```
~/orpheus-aviary-nest/
├── owl/
│   ├── owl_config.toml
│   ├── owl.db              # 工作数据库（better-sqlite3 独占）
│   ├── owl.db-wal          # SQLite WAL 文件
│   ├── owl.sync.db         # 同步副本（migration 读写）
│   └── logs/
│       ├── owl.log
│       └── daemon.log
├── lark/
├── jay/
├── aviary/
└── migration/
    ├── config.toml
    ├── logs/
    └── state/
        ├── sync.cursor     # 同步游标（timestamp）
        └── conflicts/      # 冲突记录
```

### 双文件同步策略

- `owl.db` — 应用独占，better-sqlite3 + WAL 模式
- `owl.sync.db` — migration 进程读写的同步副本
- 同步方向：owl.db → owl.sync.db（定期 `.backup` API）；migration 同步 owl.sync.db ↔ 远程主机
- 远程变更：migration 更新 owl.sync.db → 通知 daemon → daemon 将变更合并到 owl.db
- 应用完全不感知 migration 的存在

## 4. Migration 架构（已确定）

### 角色模式

| 模式 | 命令 | 职责 |
|------|------|------|
| 主机 | `migration host --port 47020 --password <pwd>` | 启动 HTTP/WebSocket server，暴露 sync API，监控本地文件变更，管理多从机 |
| 从机 | `migration connect <host:port> --password <pwd>` | 后台同步，离线队列，通过 WebSocket 通知 owl |
| 独立 | 不运行 migration | 应用正常读写本地，无同步 |

### 同步协议

```
# 主机 API
GET    /sync/manifest              # 文件 hash + mtime 清单
GET    /sync/file?path=owl/owl.sync.db  # 下载文件
PUT    /sync/file?path=owl/owl.sync.db  # 上传文件
POST   /sync/lock                  # 写锁
DELETE /sync/lock
GET    /health                     # 心跳
WS     /sync/events               # 实时变更推送
```

### 同步阶段

- 阶段 1：文件级同步（owl.sync.db 整体传输）
- 阶段 2：记录级 diff（基于 updated_at 的笔记级合并）

### 交互流程

```
┌──────────────────────────────────────────────────────────┐
│                     主机（Home）                          │
│  ┌───────────┐    ┌────────────────────────────────────┐ │
│  │  Owl GUI  │◄───┤  Migration Host (TS)               │ │
│  │  (macOS)  │    │  - HTTP/WebSocket API              │ │
│  └───────────┘    │  - 文件系统监控（chokidar）          │ │
│                   │  - 多从机管理                        │ │
│  owl.db ──backup──► owl.sync.db ──► 同步分发             │ │
│                   └────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
                            │ WebSocket / HTTP
┌──────────────────────────────────────────────────────────┐
│                    从机（Office）                          │
│  ┌───────────┐    ┌────────────────────────────────────┐ │
│  │  Owl GUI  │◄───┤  Migration Client (TS)             │ │
│  │ (Windows) │    │  - 连接主机                         │ │
│  └───────────┘    │  - 后台同步                         │ │
│                   │  - 离线队列                          │ │
│  owl.sync.db ◄────┼── 接收同步                           │ │
│       │           └────────────────────────────────────┘ │
│       ▼                                                   │
│  ┌───────────┐                                            │
│  │Owl Daemon │◄── 监听 sync.db 变更 → 合并到 owl.db       │
│  │ (TS/Node) │──► 系统通知                                │
│  └───────────┘                                            │
└──────────────────────────────────────────────────────────┘
```

### Owl 与 Migration 的交互边界

- **配置**：Owl 设置页面写入 `migration/config.toml`
- **触发**：Owl 调用 `migration connect <host>` 启动同步
- **感知**：Migration 通过 WebSocket 通知 Owl daemon 状态变更
- **冲突**：Migration 标记冲突到 `state/conflicts/`，Owl 提供解决 UI

## 5. PLAN_TO_JS.md 新功能清单

### 编辑界面改进
- [ ] CodeMirror 6 成熟配置（语法高亮、`- ` / `1. ` 换行、Tab 缩进）
- [ ] 完整快捷键支持（Cmd+W 关闭标签等）
- [ ] LaTeX 行间公式居中
- [ ] 分屏模式拖拽调整宽度 + 滚动同步
- [ ] 完整 Markdown 渲染（三级以上标题、行内代码、代码块语言高亮、表格横向滚动、HTML 渲染、脚注链接）
- [ ] 标签修改算作笔记更新

### 浏览界面新功能
- [ ] 文件夹机制（嵌套、拖拽、命名、手动排序）
- [ ] 一键展开/折叠文件夹
- [ ] 搜索和筛选兼容文件夹结构

### 新增页面
- [ ] 待办界面：检索所有笔记中 `- [ ]`，按笔记标题整理，支持折叠/勾选/完成标记
- [ ] 设置页面：远程配置、UI 配置等

### AI 界面重构
- [ ] 删除旧版同义词/分词工具
- [ ] AI 工具调用模式（search tool → 检索笔记 → 组装上下文 → 回答）
- [ ] 标签也可被检索
- [ ] 修复 Markdown 渲染问题
- [ ] 保留跳转到对应笔记功能
- [ ] AI 内部支持外部调用的所有工具

### 外部调用（@owl/cli）
- [ ] 搜索笔记（返回 id + 内容）
- [ ] 按 id 访问笔记
- [ ] 拉起 GUI 界面
- [ ] 创建笔记（标题含"(AI新建)"）
- [ ] 编辑笔记（拉起 GUI 预览，用户手动确认）
- [ ] 专项操作：添加提醒、随记、待办（硬编码 UUID，无需确认）
- [ ] 环境感知：有 GUI 时暴露 GUI 工具，无 GUI 时只暴露直接编辑工具

## 6. 设计原则（已确定）

- **不参考 Go 版实现**，从零设计，一步到位
- Go 版的问题：编辑器体验差、渲染不完整、快捷键实现僵硬、扩展性差
- 新版目标：现代化 UI、完整 Markdown 体验、可扩展架构
- **数据库 schema 全新设计**，不兼容旧版（用户已备份 `orpheus-aviary-nest_副本`）
- Migration（P4）在 P3 之后开发，owl 中远程模块保持独立，方便后续修改
- 测试策略：core 单元测试（drizzle 查询）、daemon API 集成测试（supertest）、前端手动验证

## 7. 实施阶段总览（已确定）

| 阶段 | 目标 | 交付物 |
|------|------|--------|
| **P0** | 骨架 + 数据层 + 最小闭环 | monorepo + @owl/core + daemon CRUD API + 空壳 Electron |
| **P1** | 编辑器 + 浏览 + 回收站 + 提醒 | 完整笔记管理 GUI（解决所有渲染问题） |
| **P2** | 文件夹 + 待办 + AI 工具调用 + 设置 | 全部新功能 |
| **P3** | 外部调用 | @owl/cli 单二进制 + agent skill 接口 |
| **P4** | Migration | migration TS 实现 + owl 集成 |

依赖关系：`P0 → P1 → P2 → P3 → P4`（严格顺序）

## 8. 数据库 Schema（已冻结）

### 设计原则

- 时间字段统一 INTEGER（Unix 毫秒），tag_value 保持 TEXT
- 固定长度字段在前，可变长度（content）在后，减少页面碎片
- FTS5 混合同步：content 用触发器自动同步，tags_text 由业务层维护
- 不引入 vector_clock，不预留字段
- `local_metadata` 仅存在于 owl.db，不进入 sync.db

### SQL Schema

```sql
CREATE TABLE folders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  parent_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  device_id   TEXT
);

CREATE TABLE notes (
  id            TEXT PRIMARY KEY,
  folder_id     TEXT REFERENCES folders(id) ON DELETE SET NULL,
  trash_level   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  trashed_at    INTEGER,
  device_id     TEXT,
  content_hash  TEXT,
  content       TEXT NOT NULL
);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  tag_type   TEXT NOT NULL,
  tag_value  TEXT,
  UNIQUE(tag_type, tag_value)
);

CREATE TABLE note_tags (
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (note_id, tag_id)
);

-- FTS5 external content table
CREATE VIRTUAL TABLE notes_fts USING fts5(
  content,
  tags_text,
  content=notes,
  content_rowid=rowid
);

-- FTS5 触发器（自动同步 content 字段）
CREATE TRIGGER notes_fts_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, content, tags_text)
  VALUES (new.rowid, new.content, '');
END;

CREATE TRIGGER notes_fts_delete AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content, tags_text)
  VALUES ('delete', old.rowid, '', '');
END;

CREATE TRIGGER notes_fts_update AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content, tags_text)
  VALUES ('delete', old.rowid, '', '');
  INSERT INTO notes_fts(rowid, content, tags_text)
  VALUES (new.rowid, new.content, '');
END;

-- 本地元数据（仅 owl.db，不进入 sync.db）
CREATE TABLE local_metadata (
  key    TEXT PRIMARY KEY,
  value  TEXT
);
-- 预置 key: device_uuid, last_backup_at, sync_version
```

### Drizzle Schema 定义

```typescript
// @owl/core/src/db/schema.ts
import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const folders = sqliteTable('folders', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  parentId: text('parent_id').references((): AnyColumn => folders.id, { onDelete: 'set null' }),
  position: integer('position', { mode: 'number' }).notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  deviceId: text('device_id'),
});

export const notes = sqliteTable('notes', {
  id: text('id').primaryKey(),
  folderId: text('folder_id').references(() => folders.id, { onDelete: 'set null' }),
  trashLevel: integer('trash_level', { mode: 'number' }).notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  trashedAt: integer('trashed_at', { mode: 'timestamp_ms' }),
  deviceId: text('device_id'),
  contentHash: text('content_hash'),
  content: text('content').notNull(),
});

export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  tagType: text('tag_type').notNull(),
  tagValue: text('tag_value'),
}, (table) => [
  unique().on(table.tagType, table.tagValue),
]);

export const noteTags = sqliteTable('note_tags', {
  noteId: text('note_id').notNull().references(() => notes.id, { onDelete: 'cascade' }),
  tagId: text('tag_id').notNull().references(() => tags.id),
}, (table) => [
  primaryKey({ columns: [table.noteId, table.tagId] }),
]);

export const localMetadata = sqliteTable('local_metadata', {
  key: text('key').primaryKey(),
  value: text('value'),
});
```

### 专项笔记

```typescript
// @owl/core/src/special-notes.ts
export const SPECIAL_NOTES = {
  MEMO: '00000000-0000-0000-0000-000000000001',
  TODO: '00000000-0000-0000-0000-000000000002',
} as const;

// 应用启动时调用，用户删除后自动重建
export async function ensureSpecialNotes(db: Database) { ... }
```

## 9. P0：骨架搭建 — Commit 分解

### P0-1: monorepo 初始化

**目标**：搭建 pnpm workspace + 共享配置

**内容**：
- `pnpm-workspace.yaml` 定义 packages/* 和 apps/*
- 根 `package.json`（scripts: lint, typecheck, build）
- `tsconfig.base.json`（共享 TS 配置，strict mode）
- `biome.json`（lint + format 规则）
- `.gitignore`、`.node-version`
- 空的 `packages/core/`、`packages/daemon/`、`packages/gui/`、`apps/cli/` 各含 `package.json` + `tsconfig.json`

**验证**：`pnpm install` 成功，`pnpm -r exec echo ok` 所有包正常

---

### P0-2: @owl/core — 数据库层

**目标**：drizzle schema + SQLite 初始化 + 基础查询

**内容**：
- `packages/core/src/db/schema.ts` — 上面冻结的 drizzle schema
- `packages/core/src/db/index.ts` — better-sqlite3 初始化（WAL 模式、外键、FTS5 触发器）
- `packages/core/src/db/migrate.ts` — drizzle migration 执行
- `packages/core/src/special-notes.ts` — 专项笔记保障
- `drizzle.config.ts` — migration 配置
- 生成首个 drizzle migration 文件

**验证**：单元测试 — 初始化 DB → 表结构正确 → FTS5 触发器工作 → 专项笔记自动创建

---

### P0-3: @owl/core — 配置 + 日志

**目标**：TOML 配置读写 + pino 日志

**内容**：
- `packages/core/src/config/index.ts` — 读写 `owl_config.toml`，类型定义，默认值
- `packages/core/src/config/paths.ts` — `~/orpheus-aviary-nest/owl/` 路径管理
- `packages/core/src/logger/index.ts` — pino + pino-roll 封装

**验证**：单元测试 — 配置文件不存在时创建默认 → 读取/写入正确 → 日志文件轮转

---

### P0-4: @owl/core — 笔记 CRUD + 标签解析

**目标**：核心业务逻辑

**内容**：
- `packages/core/src/notes/index.ts` — create / get / list / update / delete / restore / batchDelete / batchRestore
- `packages/core/src/tags/parser.ts` — 标签字符串解析（#文本、/time、/alarm、/daily 等）
- `packages/core/src/tags/time.ts` — 时间智能推断（省略格式处理）
- `packages/core/src/search/index.ts` — FTS5 搜索 + tags_text 更新逻辑
- `packages/core/src/notes/hash.ts` — content SHA-256 计算

**验证**：单元测试覆盖所有 CRUD + 标签解析边界情况 + FTS 搜索 + content_hash 计算

---

### P0-5: @owl/daemon — Fastify HTTP server

**目标**：REST API 暴露 core 功能

**内容**：
- `packages/daemon/src/server.ts` — Fastify 实例 + 插件注册
- `packages/daemon/src/routes/notes.ts` — 笔记 CRUD 路由
- `packages/daemon/src/routes/tags.ts` — 标签查询 + 提醒查询
- `packages/daemon/src/routes/system.ts` — /status、/api/capabilities
- `packages/daemon/src/cli.ts` — commander 入口（`owl daemon`、`owl daemon-status`）
- PID 文件管理

**API 路由设计（已确定）**：

标准 CRUD（RESTful）：
```
GET    /notes              # 列表（query: folder_id, trash_level, q）
GET    /notes/:id          # 详情
POST   /notes              # 创建（body: content, folder_id?）
PUT    /notes/:id          # 全量更新（替换 content）
PATCH  /notes/:id          # 部分更新（如只改 folder_id）
DELETE /notes/:id          # 移至回收站（软删除）
```

Action 路由（POST 动词）：
```
POST /notes/:id/restore           # 从回收站恢复
POST /notes/:id/permanent-delete  # 彻底删除
POST /notes/batch-delete          # 批量软删除（body: {ids: string[]}）
POST /notes/batch-restore         # 批量恢复
POST /notes/batch-move            # 批量移动文件夹
```

标签 & 提醒：
```
GET /tags                  # 查询 # 标签（query: search）
GET /tags/frequent         # 高频标签（query: limit）
POST /parse-tag            # 解析标签字符串
GET /reminders             # 时间范围内提醒（query: from, to）
GET /reminders/upcoming    # 即将到期（query: within_minutes）
```

系统：
```
GET /status                # 健康检查
GET /api/capabilities      # 所有可用操作描述
```

统一响应格式：`{"success": bool, "data": {}, "message": "..."}`

**验证**：API 集成测试（supertest）— 全 CRUD 路由正确 → 统一响应格式 → PID 管理

---

### P0-6: @owl/gui — Electron 空壳

**目标**：最小可运行的 Electron 窗口

**内容**：
- `packages/gui/electron.vite.config.ts`
- `packages/gui/src/main/index.ts` — 窗口创建 + daemon 自启动检测
- `packages/gui/src/main/ipc.ts` — daemon 地址传递
- `packages/gui/src/preload/index.ts`
- `packages/gui/src/renderer/` — 空白 React 页面 + react-router 骨架（6 个页面占位）+ Tailwind 配置
- shadcn/ui 初始化

**验证**：`pnpm --filter @owl/gui dev` → Electron 窗口启动 → 自动拉起 daemon → 页面路由可切换

---

### P0 完成标志

- [x] monorepo 结构完整，依赖正确
- [x] `owl daemon` 可独立启动，API 可用
- [x] Electron GUI 启动时自动拉起 daemon
- [x] 通过 API 可创建/读取/搜索笔记
- [x] 所有单元测试和集成测试通过
- [x] `pnpm run lint` + `pnpm run typecheck` 零错误

## 10. P1 ~ P4 概要（待后续展开）

> P0 实施完成后，逐个展开 P1 ~ P4 的 commit 分解
