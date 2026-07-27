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
- **skybridge 同步**（per-profile，0.5.0/P5-d）：`owl.db` 有 `sync_changes`/`sync_cursor`/`conflict_record` 表；每账号 `profiles/<id>/owl.db`，**local `owl/owl.db` 永不被账号同步写**（D10b）。登录/切换/设备管理全在 GUI（Settings → 同步），daemon 不写 toml、靠 GUI main 经 `POST /sync/session` 注入明文 token。架构 `aviary/docs/SKYBRIDGE_ARCH.md`；完整实施 `docs/history/P5-d-shipped.md`；本地开发/部署 `skybridge/docs/deploy/ubuntu-baota.md`
- **skybridge daemon.log debug 关键字**：`sse-bridge`（started/skipped/connected/SSE error/`idle watchdog fired`）· `kind:'sync'`（runSync push/pull/apply/LWW）· `kind:'sync-scheduler'`（`[sync].interval_min` default 5min，`<=0` 禁用）· `kind:'outbox-watcher'`（push-on-mutation：started / `pending outbox, syncing`(debug) / 退避 warn / 无 session idle）· `kind:'cloud-refresh'`（三态 + recovery 重排 + refresh-on-401）· `kind:'health-probe'`（onError 退避期 10s `/health`）· `kind:'mid-session-bootstrap'` · `[REDACTED]`（pino redact）。SSE 永久重连退避 `[2,4,8,16,30]s+jitter`（无手动重连按钮，offline 是信息态）+ idle watchdog 60s 半开假死自动重连。彻底重启 bridge：`just stop-daemon && just dev-daemon`
- **同步触发器（0.6.1）**：SSE `change` / 重连 `onOpen` / scheduler（`interval_min`）/ 手动 `/sync/run` / **`sync/outbox-watcher.ts` push-on-mutation**（1s 轮询已提交 outbox，debounce 800ms + maxWait 5s，退避 `[2,4,8,16,30]s+jitter`）。**任何轮询型触发器必须自带 singleflight** —— `createCoalescer` 的 follow-up 在前一轮 reject 后照跑，否则退避形同虚设。所有触发器先过 `sync/trigger-gate.ts` 的 `syncTriggerReady`（两种 mode 都只看 `ctx.skybridgeSession != null`；P5-d Phase 10 起 daemon 不读 toml、不认明文 token）。
- **`@owl/server` 必须是单文件 bundle**：publish manifest 的 `files` 只列 `index.js`，一个 `await import()` 就让 tsup 拆出 hashed chunk → 发出去的包首次使用即炸。`gen-publishable-manifest.mjs` 已 fail-closed 拦截。
- **skybridge token 安全（路 C）**：`skybridge_config.toml` chmod 0600（local secret）+ GUI safeStorage keychain 加密（`encrypted_token`/`encrypted_refresh_token`）；token 不进 log/UI（pino redact + `redactToken()` 拼接 helper）。`just check` 8 守卫含 core-convergence / token-not-templated / daemon-no-electron-storage / no-prod-env-token / session-body-not-logged / daemon-no-toml-write

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
**🎉 owl 0.6.1 已发版（2026-07-27）** —— 桌面 dmg + `@orpheus-aviary/owl-server@0.6.1`（owl-cli 无改动仍 0.6.0）。
0.6.1 是 0.6.0 真机使用后的**跨设备同步修复批**：push-on-mutation、远端变更前端自动刷新、桌面 CAS、
special-notes 确定性 seed（migration `0010`）。见 `docs/plans/2026-07-24-problem-a-auto-sync-plan.md`
（含三轮审阅的逐条核实记录）+ `docs/history/0.6.1-release-notes.md`。
**⭐ 通往 1.0.0 的路线 = `docs/plans/2026-07-04-road-to-1.0.0.md`**（Stage 1 全本地已完 → Stage 2 上云：
公网部署✅ + TLS/反代 + soak + P6 GA → 1.0.0；RN 移动 app + 跨 profile 视图 = 1.0.0 后）。
当前状态 + 下一步**以 `PROCESS.md` 为准**；扩生态总架构 `docs/plans/2026-06-06-mobile-web-ecosystem-arch.md`；
跨仓路线 `aviary/docs/ROADMAP.md`；P5-d 归档 `docs/history/P5-d-shipped.md`；0.6 backlog 原始清单 `docs/plans/2026-06-06-0.6.0-plan.md`。