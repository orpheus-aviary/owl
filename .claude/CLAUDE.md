# owl-ts 开发规范

## 项目概述
owl-ts 是猫头鹰笔记的 TypeScript 重写版，使用 Electron + Node.js。从零设计，不参考 Go 版实现。

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
- **daemon 统一入口**：CLI 和 GUI 都通过 daemon HTTP API 操作数据
- **daemon 自启动**：GUI 启动时检测并拉起 daemon，daemon 独立于 GUI 生命周期
- **统一响应格式**：`{"success": bool, "data": {}, "message": "..."}`
- **数据目录**：`~/orpheus-aviary-nest/owl/`
- **owl.sync.db**：migration 同步副本，应用不直接读写

## Commit 规范
遵循上级 `orpheus-aviary/.claude/CLAUDE.md` 中的 Conventional Commits 规范。
Scope: `db` / `config` / `notes` / `tags` / `daemon` / `gui` / `editor` / `browser` / `trash` / `reminders` / `ai` / `todo` / `settings` / `cli`

## 当前进度
见 `PROCESS.md`，完整计划见 `docs/plans/COEDIT_PLAN.md`。
