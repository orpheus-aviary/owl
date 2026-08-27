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
- **skybridge daemon.log debug 关键字**：`sse-bridge`（started/skipped/connected/SSE error/`idle watchdog fired`）· `kind:'sync'`（runSync push/pull/apply/LWW）· `kind:'sync-scheduler'`（`[sync].interval_min` default 5min，`<=0` 禁用）· `kind:'outbox-watcher'`（push-on-mutation：started / `pending outbox, syncing`(debug) / 退避 warn / 无 session idle）· `kind:'cloud-refresh'`（三态 + recovery 重排 + refresh-on-401）· `kind:'health-probe'`（onError 退避期 10s `/health`）· `kind:'mid-session-bootstrap'` · `kind:'sync-retention'`（0.6.2 W2 outbox 裁剪：deleted/cutoff/pulled_seq/safe_after；`pruned:false` 每进程每 reason 只 warn 一次）· **`msg:'sync round done'`（0.6.3 V2，每轮成功同步一条 info：`triggers` 数组 + `cursor_before/after` + pulled/applied/skipped/pushed/duplicates/server_seq_high/conflicts）** · **`kind:'session-watchdog'`（0.6.3 V3，cloud-only：`started` / `reason:'no_session'` warn 满 10 分钟首报 + 每小时 / `sync resumed`）** · `[REDACTED]`（pino redact）。
  ⚠️ **逐条变更的 apply/skip 日志是 debug 级**（0.6.3 V2 降的），默认看不到 —— 排查单条变更要临时把 `[log].level` 调到 debug。SSE 永久重连退避 `[2,4,8,16,30]s+jitter`（无手动重连按钮，offline 是信息态）+ idle watchdog 60s 半开假死自动重连。彻底重启 bridge：`just stop-daemon && just dev-daemon`
- **同步触发器（0.6.1）**：SSE `change` / 重连 `onOpen` / scheduler（`interval_min`）/ 手动 `/sync/run` / **`sync/outbox-watcher.ts` push-on-mutation**（1s 轮询已提交 outbox，debounce 800ms + maxWait 5s，退避 `[2,4,8,16,30]s+jitter`）。0.6.3 起每个触发点给 `runManualSync(ctx, trigger)` 传标签（`sse`/`sse-reconnect`/`scheduler`/`outbox`/`manual`），**由 coalescer 按槽累积成集合**再打进 round summary —— 单个全局字段会在并发触发时错标。**任何轮询型触发器必须自带 singleflight** —— `createCoalescer` 的 follow-up 在前一轮 reject 后照跑，否则退避形同虚设。所有触发器先过 `sync/trigger-gate.ts` 的 `syncTriggerReady`（两种 mode 都只看 `ctx.skybridgeSession != null`；P5-d Phase 10 起 daemon 不读 toml、不认明文 token）。
- **同步状态机（0.6.2 W3）**：`SyncState` 多一个 `auth_required` + `auth_reason`（`missing_session` < `token_rejected` < `credentials_missing`，**弱不覆盖强**，否则重装被拒 token → 401 死循环）。**粘性**：`markError`/`markOffline` 不降级、`markSyncing` 无 session 时不动、只有 `markSuccess`/`markSessionInstalled`/broadcaster evict 能清。产生者统一走 `sync/auth-signal.ts`（非账号 profile 落 `markError`，否则手动同步会永久卡「同步中」）；账号判定 `sync/account-profile.ts`（看 daemon **实际打开的库**，`':memory:'` 与 local 库一律非账号）。SSE 401 = 认证不是掉线 → 停重连 + 进状态机。`GET /sync/status` 带 state/auth_reason/last_error（冷启动 renderer 唯一来源）。renderer 三条写 store 的路径统一走 `stores/sync-status.ts` 的 `commitSnapshot`。恢复在 GUI main `sync-auth-recovery.ts`：外部入口 `requestRecovery` **按 reason 限流 10s** / 内部退避入口 `runRecoveryAttempt` **不限流**。⚠️ 两条都是真机踩出来的：内部退避走外部入口会被吞且不再排期；外部限流若共用一个时间戳，「daemon 重启 → 重装过期 token → subscribe 401」这条 1.5s 内 reason 升级的链会被静默丢弃 → 永久卡「需登录」。generation 进队列前捕获、拿锁后再比；退避 `[2,5,10,30,60]s` 睡在队列外。
- **`@owl/server` 必须是单文件 bundle**：publish manifest 的 `files` 只列 `index.js`，一个 `await import()` 就让 tsup 拆出 hashed chunk → 发出去的包首次使用即炸。`gen-publishable-manifest.mjs` 已 fail-closed 拦截。
- **skybridge token 安全（路 C）**：`skybridge_config.toml` chmod 0600（local secret）+ GUI safeStorage keychain 加密（`encrypted_token`/`encrypted_refresh_token`）；token 不进 log/UI（pino redact + `redactToken()` 拼接 helper）。`just check` **10 守卫**：core-convergence / token-not-templated / daemon-no-electron-storage / no-prod-env-token / session-body-not-logged / daemon-no-toml-write / renderer-owlapi-confined / shared-no-node-electron / cloud-creds-no-disk / **session-watchdog-wired**（0.6.3 V3）

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
**🎉 owl 0.6.4 已发版（2026-08-27）** —— 桌面 dmg + `@orpheus-aviary/owl-server@0.6.4` +
**`@orpheus-aviary/owl-cli@0.6.4`**（⚠️ CLI 发布名带 scope，别写成 `owl-cli`）。**无 migration**，
`user_version` 仍 11，协议不变、可与 0.6.3 混用。
0.6.4 = **设备列表按工具过滤 + 折叠已撤销**（设备是按账号注册的，lark 的混在同一个响应里；
skybridge 的 `devices` 表没有 tool 列 ⇒ 只能按 `app_version` 前缀判，规则/文案与
lark `packages/shared/src/sync-devices.ts` **有意逐字一致**）+ 🔴 **登录自愈**（此前拿着被撤销的
device id 登录会「成功」，之后每次同步 403 `DEVICE_FORBIDDEN`，而 403 不进 401 那套自愈 ⇒
退出重登也救不回来）。说明 `docs/history/0.6.4-release-notes.md`。
⚠️ **发版时 `OWL_APP_VERSION`（`core/src/version.ts`）必须跟着走** —— 它是 `registerDevice`
写的 `app_version`，新的设备过滤按这个前缀判；0.6.0 漏过一次。

上一版 **0.6.3（2026-08-11）** —— 无 migration。桌面 + 云端真机验收全过。
0.6.3 = 0.6.2 长期使用测试复盘挖出的一批同步问题：**游标互相清零**（每次本地写入后全量重放
整条变更日志）· **轮次 summary 日志**（这个缺失正是前者藏三周的原因）· **pin/reorder 跨设备** ·
**云端 session watchdog**。计划 + **详细现象记录** + 三轮审阅修订见
`docs/plans/2026-08-11-0.6.3-plan.md`，用户可见说明 `docs/history/0.6.3-release-notes.md`。
上一版 0.6.2（2026-07-27，**migration `0011`**）= 桌面 token 自愈 + conflict LWW 三元组 +
`sync_changes` 裁剪，见 `docs/plans/2026-07-27-0.6.2-plan.md`（§7.1 是 W2 的首次真机复盘，
§11 记了一个只有真机时序能踩出来的限流 bug）+ `docs/history/0.6.2-release-notes.md`。
**⭐ 通往 1.0.0 的路线 = `docs/plans/2026-07-04-road-to-1.0.0.md`**（Stage 1 全本地已完 → Stage 2 上云：
公网部署✅ + TLS/反代 + soak + P6 GA → 1.0.0；RN 移动 app + 跨 profile 视图 = 1.0.0 后）。
当前状态 + 下一步**以 `PROCESS.md` 为准**；扩生态总架构 `docs/plans/2026-06-06-mobile-web-ecosystem-arch.md`；
跨仓路线 `aviary/docs/ROADMAP.md`；P5-d 归档 `docs/history/P5-d-shipped.md`；
**待办清单（B1/B2/C2/C5 已划掉；C6 + C7 + D9 待拍板）= `docs/plans/2026-07-27-backlog-as-of-0.6.1.md`**；0.6 backlog 原始清单 `docs/plans/2026-06-06-0.6.0-plan.md`。
**W2 裁剪体检**：`just sync-retention-report <owl.db>`（判读见脚本头注释 —— 装没装要看 db 不能看日志）。