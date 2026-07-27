# 开发进度

## 当前阶段：**🎉 0.6.1 已发版（2026-07-27）→ 下一步 Stage 2 收尾**

0.6.0（2026-07-23）转真机长期使用测试，暴露的跨设备同步问题在 0.6.1 一批修完并发版。
主线是 **Problem A（跨 skybridge 自动同步不生效）**，计划 + 三轮审阅记录见
`docs/plans/2026-07-24-problem-a-auto-sync-plan.md`，用户可见说明见
`docs/history/0.6.1-release-notes.md`。

### 0.6.1 发布内容

| 包 | 版本 | 渠道 |
|---|---|---|
| 桌面 | `Owl-0.6.1-arm64.dmg` | GitHub Release `v0.6.1` |
| owl-server | `@orpheus-aviary/owl-server@0.6.1` | npm（`latest`）|
| owl-cli | 0.6.0 **不变** | 无改动，不重发 |

⚠️ **同步类修复必须两端都升**：桌面和 owl-server 跑同一套 daemon/core 同步代码。
本版含一个 migration（`user_version` 9 → 10），单向不可回滚，升级前备份 db。

### 0.6.1 修了什么

**先修的两个（真机直接踩到）**
- 状态栏读 installed session —— 修「登录后闪『已同步』又退回『本地』」（`d95272a`）。
- 冲突误报 B —— 只在有 **pending**（`synced_at IS NULL`）本地编辑时记冲突，fast-forward 不再误报（`4fd1a79`）。冲突在**接收侧**判定，所以两端都要跑修复。

**Problem A 主线**
- **push-on-mutation**（Phase 1）—— `sync/outbox-watcher.ts` 每秒轮询已提交 outbox，debounce 800ms / maxWait 5s / 退避 `[2,4,8,16,30]s+jitter`。此前根本没有「本地写入 → 推送」触发器，发方向只能等定时器。选轮询而非进程内事件的三个理由（覆盖 daemon 外的写入、`emitSyncChange` 契约要求在事务内、boot 时天然自带 pending 扫描）见计划 §6。
- **触发 gate**（Phase 1/3）—— `sync/trigger-gate.ts`：`syncTriggerReady` 两种 mode 都只看 `ctx.skybridgeSession != null`；`syncRecoveryCapability` 返回 `{canReinstall, canRefresh}` 仅供日志/分派。scheduler 与 watcher 共用，无 session 时静默跳过 + 只打状态转换日志（旧日志 163 条刷屏 → 2 条）。
- **cloud refresh 三态**（Phase 2B 前置）—— `refreshCloudSession` 返回 `{outcome, error?}`。**独立真 bug**：旧实现 catch 到任何异常都 `teardownCloudSession`，一次网络抖动就清空云端 RAM 凭据 + 注销所有 Layer-2 会话。现在 transient 保留凭据并按 `[30,60,120,300]s` 重排恢复定时器（复用 `ctx.refreshTimer`）。
- **401 自刷新**（Phase 2B 后半）—— `attemptSyncRound` 拆分 + `maybeRecoverCloudSession`：cloud 401 → refresh → 重试一轮，30s 冷却；desktop 不走此路（没有 refresh token）。
- **special notes 确定性 seed**（Phase 4）—— `SEED_TS=0` + migration `0010`。迁移只归零 pristine 行：`created_at = updated_at` + 内容等默认模板 + 没有**带 `updated_at_ms`** 的 outbox 行（按 payload 判而非按 op —— reorder 也是 `op='update'` 但只带 `{position}`）。
- **部署不变量**（Phase 5）—— skybridge 必须单实例 fork，写进 `docs/deploy/baota-fish-runbook.md` + `pm2 describe` 确认步骤。进程内探测不可靠（`NODE_APP_INSTANCE` 是序号不是总数），只能靠部署纪律。

**计划外（真机验收时用户提出）**
- **远端变更前端自动刷新** —— daemon 在 `appliedTotal > 0` 时发 `notes:changed`；renderer bump 列表 + `reconcileRemoteChanges()` 逐个开着的标签页比对：版本没动不碰 / 干净 adopt 远端 / 脏只打 `remoteUpdated` 标记走 banner。成本按打开的标签数算，不按变更数算。
- **桌面 CAS** —— `expected_updated_at` 此前只在网页端发，桌面 stale 保存会**静默覆盖**同步进来的远端编辑（无 409、无对话框，覆盖还会 LWW 传播出去）。现在两端都走 `VersionConflictDialog`。

### 本轮的关键教训（写进不变量）

- **coalescer 的 follow-up 在前一轮 reject 后照跑** → 任何轮询型触发器必须自带 singleflight，否则退避形同虚设。
- **`@owl/server` 必须是单文件 bundle**：一个 `await import()` 就让 tsup 拆出 hashed chunk，而 publish manifest 的 `files` 只列 `index.js` → 发出去的包会在首次使用时炸。已给 `gen-publishable-manifest.mjs` 加 fail-closed 检查。
- **`MAX(local_seq) WHERE synced_at IS NULL` 不需要新索引**：`local_seq` 是 rowid = 现有 partial index 的隐式尾列，实测 0.4µs/200k pending 行；真正贵的是 `count(*)`（1772µs），已移出热路径。

### 待办

- [ ] **Phase 2A**（Problem A 唯一剩下的实现项，用户定：不影响使用，延后）：desktop token 过期自动恢复 —— 事件带 reason（`missing_session` / `token_rejected`）、状态（broadcaster，可查询）与命令（瞬时事件）拆开、`logged_out` 调 `clearSkybridgeAuth()`。触及 9 处：`SyncState` 两份定义 + broadcaster + manual 401 分支 + `/sync/session`/`logout-local` 路由 + renderer 转发 + preload/IPC + main `recoverSession` + 状态栏 UI。**开工前先拍板 `SyncState` 是否加 `auth_required`**（推荐加）。
- [ ] 剩 Stage 2 收尾 → 🎯1.0.0：TLS / 反代 · 真·24h soak · P6 多设备 GA（skybridge Phase 5）。
- [ ] 1.0.0 后：跨 profile 统一视图 · 完整 RN 移动 app（Phase C→D→E）· 其余 0.6+ backlog。

---

## 历史归档

每个已 ship 阶段的实施细节收在对应设计文档的 `## 实施记录` 段，或 `docs/history/` 下的专题 doc：

| 阶段 | 位置 |
|---|---|
| P0 / P1 基础搭建 | `docs/history/P0-P1-shipped.md` |
| P2 功能完善 | `docs/history/P2-shipped.md` |
| P3.0.5 pre-release polish | `docs/history/P3-0-5-shipped.md` |
| P3.1 GUI 0.2.0 首发 | `docs/plans/2026-04-28-p3-1-gui-0.2.0-release-design.md` § 实施记录 |
| P3.2-a~d / P3.2.5 | 对应 `docs/plans/2026-04-29`…`2026-05-03-*.md` § 实施记录 |
| P3.3 0.3.0 发版 | `docs/history/P3-3-shipped.md` |
| P3.4 UX + P4 skybridge Phase 1+2 + 0.4.0 发版 + 0.4.1 hotfix | `docs/history/P3-4-P4-shipped.md` |
| P5-a 单机 sync engine（内部 2026-05-22） | `docs/history/P5-a-shipped.md` |
| P5-b 多 entity + SSE + GUI（内部 2026-05-24） | `docs/history/P5-b-shipped.md` |
| P5-c 后台 + retry + conflict + token-mask（内部 2026-05-25） | `docs/history/P5-c-shipped.md` |
| **0.4.2 发版**（全局快捷键 + skybridge npm 切换） | GitHub Release v0.4.2 + `docs/history/P5-c-shipped.md` |
| **P5-d per-profile 隔离 + 免密快切 → 0.5.0 发版** | **`docs/history/P5-d-shipped.md`** + `docs/history/0.5.0-release-notes.md` |
| **扩生态 → 1.0.0 路线（两阶段）** | `docs/plans/2026-07-04-road-to-1.0.0.md` + `docs/plans/2026-06-06-mobile-web-ecosystem-arch.md` |
| Phase A 云端 daemon（A0–A6）+ Phase B 网页版（B0–B4）| 各 `docs/plans/2026-06-12`…`2026-06-19-*.md` § 实施记录 |
| **Stage 1**：owl-server 打包 · A6 local CSRF · 重构一轮 · 0.6 本地功能 · 移动 web UI + PWA | `2026-07-04-owl-server-packaging.md` · `2026-07-15-a6-local-csrf.md` · `2026-07-15-refactor-round.md` · `2026-07-16-0.6-local-features.md` · `2026-07-22-mobile-web-ui.md` |
| **Stage 2 公网部署 + 0.6.0 三端发版**（2026-07-23：阿里云/宝塔 skybridge 0.1.4 + owl-server 0.6.0；桌面 dmg GitHub Release v0.6.0；owl-cli npm；异地真机/PWA 验收）| `docs/deploy/baota-fish-runbook.md` + `docs/history/0.6.0-release-notes.md` |
| **0.6.1 跨设备同步修复**（2026-07-27：Problem A push-on-mutation + 前端自动刷新 + 桌面 CAS + special-notes seed；桌面 dmg + owl-server npm）| `docs/plans/2026-07-24-problem-a-auto-sync-plan.md` + `docs/history/0.6.1-release-notes.md` |

## 关键参考

- 跨仓路线：`aviary/docs/ROADMAP.md`
- skybridge 架构框架：`aviary/docs/SKYBRIDGE_ARCH.md`
- per-profile 隔离父设计（v6 定稿）：`docs/plans/2026-05-29-account-profile-isolation-design.md`
- skybridge 本地开发/调试/发布：见 owl `CLAUDE.md` skybridge 段 + `skybridge/docs/deploy/ubuntu-baota.md`
- 部署/运维（阿里云宝塔 + fish + PM2）：`docs/deploy/baota-fish-runbook.md`
- 历史 P3 总规划（§8 已作废）/ COEDIT 早期规划：`docs/plans/2026-04-20-p3-plan.md` / `docs/plans/COEDIT_PLAN.md`
