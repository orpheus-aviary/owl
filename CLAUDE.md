# owl 开发规范

## 项目概述
owl 是猫头鹰笔记的 TypeScript 重写版，使用 Electron + Node.js。从零设计，不参考 Go 版实现。

## 技术栈
- **桌面框架**: Electron + electron-vite
- **后端**: Fastify + better-sqlite3 + drizzle-orm
- **前端**: React + TypeScript + shadcn/ui + Tailwind CSS v4 + zustand
- **编辑器**: CodeMirror 6 | **渲染**: react-markdown + rehype
- **CLI**: commander + pkg（单二进制打包）
- **Lint**: Biome | **日志**: pino | **配置**: smol-toml

## Monorepo 结构
```
packages/core/    # @owl/core — 数据库、配置、业务逻辑（纯 Node.js）
packages/daemon/  # @owl/daemon — Fastify HTTP server + CLI
packages/gui/     # @owl/gui — Electron + React 前端
apps/cli/         # @owl/cli — 外部 agent 调用入口
```

## 开发命令
```bash
just check        # lint + typecheck
just test         # 全部测试
just dev          # 启动 Electron dev
just dev-daemon   # 启动 daemon dev
```

## 注意事项
- **所有时间字段用 INTEGER（Unix 毫秒）**，tag_value 保持 TEXT
- **FTS5 混合同步**：content 用触发器，tags_text 由业务层维护
- **daemon 统一入口**：CLI 和 GUI 都通过 daemon HTTP API 操作数据；CLI `--direct` 绕过 HTTP 但仍走同一 `core`，以保证 `sync_changes` 不被绕过（P4 Phase 1）
- **daemon 自启动**：GUI 启动时检测并拉起 daemon，daemon 独立于 GUI 生命周期
- **统一响应格式**：`{"success": bool, "data": {}, "message": "..."}`
- **数据目录**：`~/orpheus-aviary-nest/owl/`
- **skybridge 对接**：P4 起在 `owl.db` 加 `sync_changes` / `sync_cursor` / `conflict_record` 表，架构见 `aviary/docs/SKYBRIDGE_ARCH.md`。旧 `owl.sync.db` 文件为 rclone bisync 方案遗留，skybridge 路线下不再使用
- **skybridge SSE bridge（P5-b Step 10a 起）**：daemon 启动后只有 `skybridge_config.toml` 同时有 `[auth] + [device.id] + [workspace.id]` 才会 auto-start bridge（见 `packages/daemon/src/sync/bridge-lifecycle.ts`）。半启动状态（login 完但还没跑过 `owl sync run`）silent skip 等下次 daemon 重启。debug 时盯 `daemon.log` 关键字 `sse-bridge`：`started` / `skipped` / `connected` / `SSE error`。手动逐发 `change`：`POST /sync/run` 触发 markSyncing → markSuccess/markError 推送 `sync:status_changed`。彻底重启 bridge：`just stop-daemon && just dev-daemon`。SSE 重连永久退避 `[2,4,8,16,30]s + 0-1s jitter`，cap 30s 不放弃 —— offline 是信息态，**没有手动 reconnect 按钮**（GUI sidebar SyncStatusBar 只显示状态）

## Commit 规范
遵循上级 `orpheus-aviary/.claude/CLAUDE.md` 中的 Conventional Commits 规范。
Scope: `db` / `config` / `notes` / `tags` / `daemon` / `gui` / `editor` / `browser` / `trash` / `reminders` / `ai` / `todo` / `settings` / `cli` / `skybridge`

## 手动测试规范

前端 GUI 变更完成后，必须输出手动测试清单，格式如下：

```
### 手动测试：<组件/功能名>

测试步骤：
1. <操作> → 预期：<结果>
2. <操作> → 预期：<结果>
...
```

**规则：**
- 每个测试步骤包含具体操作和预期效果
- Claude 在后台启动 daemon（`just dev-daemon`）并维护其生命周期
- Claude 通过 daemon API 创建/编辑适配本次测试的笔记数据
- 用户手动 `just dev` 拉起前端进行视觉验证
- 测试完成后用户反馈结果，再决定是否继续

## 当前进度
见 `PROCESS.md`，完整计划见 `docs/plans/COEDIT_PLAN.md`。