# 开发进度

## 当前阶段：**🔧 0.6.0 → 0.6.1 真机测试 + 修复环节（2026-07-24）**

0.6.0 三端已发版（2026-07-23，见历史归档），转入**真机长期使用测试**。测试暴露的问题在本环节逐个修，攒一批后发 **0.6.1** 小版本（用户定：先不逐个发，一起发）。下方「0.6.1 变更记录」是**决定哪些包需要重发的凭证**。

### 0.6.1 变更记录（= 哪些包需重发的凭证）

| # | 修改 | commit | 层/文件 | 影响的包 | 需重发 | 状态 |
|---|---|---|---|---|---|---|
| 1 | 本地同步状态读 installed session（修「登录后闪『已同步』又退回『本地』/ 手动同步变本地」）| `d95272a` | daemon（local mode）`sync/manual.ts`+`routes/sync.ts` | **桌面 dmg**；owl-server（cloud 已从 session 读，功能上 no-op，重建带上无害）| 桌面✅ / owl-server➖ | ✅ 真机验过 |
| 2 | 版本号 gui → 0.6.1 | `a0a8a2b` | `gui/package.json` | 桌面 dmg 命名 | — | ✅ |
| 3 | 冲突误报修复 B（fast-forward 不再误报；只在有 **pending**`synced_at IS NULL` 本地编辑时记冲突）| （本环节待提交）| **core** `sync/apply.ts`+`engine.test.ts` | **桌面 dmg** + **owl-server**（两端都跑此 core，冲突在接收侧判定）| 桌面✅ / **owl-server⚠️需重部署** | 桌面侧真机验过；owl-server 侧待升级 |

**重发结论（发 0.6.1 时）：**
- **桌面 `Owl-0.6.1-arm64.dmg`**：含 1+3，已打包并真机测过（`packages/gui/release/`）。
- **owl-server**：需**重建 + 重部署阿里云**才能消除「桌面改 → 网页端冲突」（接收侧 owl-server 仍跑旧 core）。`just build-server` 会带上 core 修复；升级流程见 `docs/deploy/baota-fish-runbook.md`（注意 better-sqlite3 Node24 ABI 重编）。
- **owl-cli**：无改动 → **不用重发**。

### 待办
- [ ] owl-server 重建 + 重部署（B 修复要两端都跑；用户定「等后面一起发」）。
- [ ] **Problem A（跨 skybridge 自动同步不生效）详细计划见 `docs/plans/2026-07-24-problem-a-auto-sync-plan.md`**——下轮开工。核心：无 push-on-mutation 触发器（发方向滞后 ≤5min）+ session 失效不自愈 + seed 笔记 id 冲突。
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

## 关键参考

- 跨仓路线：`aviary/docs/ROADMAP.md`
- skybridge 架构框架：`aviary/docs/SKYBRIDGE_ARCH.md`
- per-profile 隔离父设计（v6 定稿）：`docs/plans/2026-05-29-account-profile-isolation-design.md`
- skybridge 本地开发/调试/发布：见 owl `CLAUDE.md` skybridge 段 + `skybridge/docs/deploy/ubuntu-baota.md`
- 部署/运维（阿里云宝塔 + fish + PM2）：`docs/deploy/baota-fish-runbook.md`
- 历史 P3 总规划（§8 已作废）/ COEDIT 早期规划：`docs/plans/2026-04-20-p3-plan.md` / `docs/plans/COEDIT_PLAN.md`
