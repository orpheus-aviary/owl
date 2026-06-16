# 开发进度

## 当前阶段：🚧 Phase B 网页版进行中（B0+B1 完成 2026-06-14；B2 乐观并发 已 ship 2026-06-16；下一步 B3；Phase A 核心 A0–A5 已完）

**0.5.0**（per-profile 隔离 + 免密快切）已公开发版（2026-06-06）。**扩生态 Step 0** 已全部完成（2026-06-12，renderer/Electron 解耦 + `@orpheus-aviary/owl-shared`）。
**Phase A = 云端 daemon** 核心 slice **A0–A5 已完**（cloud/local 模式 + 端点鉴权 + 两层会话 + `/auth/*` + config redaction）；
剩 A6（后置，触桌面全客户端，闭 local CSRF）· Aω（发 owl-server + 上云）。
**Phase B = 网页版**（`apps/web` 瘦客户端复用 renderer 树）。子设计 → `docs/plans/2026-06-14-phase-b-web-design.md`（v1，⭐1/2/4/7 已拍板）。

- **Phase B B0+B1 已实现 + 全绿，main 未 push**：`d499d33` docs 设计稿 · `697afd8` **B0**（`apps/web` Vite 脚手架：
  `@` alias renderer 源 + 挂 `<App/>`；浏览器 `getPlatform()` 返 webAdapter；Tailwind v4 content + React dedupe；dev proxy；`just dev-web`）·
  `a4badee` **B1**（web auth/session：`web-session.ts` 内存态 token + `web.ts` 6 sync→真 HTTP + `requiresAuth` + `WebAuthGate` 登录闸
  复用 `LoginForm`(`hideServerUrl`) + transport `onUnauthorized` 401 钩子 + apps/web `main.tsx` 注 bearer）。
- **B1 验证**：`tsc -b` 绿 · gui **418**（+12 web auth 单测：session 生命周期/login 成败/logout/status/401/设备映射）· `just check` 9 守卫 · shared+web build。**桌面端零变更**（Electron `requiresAuth=false`，renderer 自身 main.tsx 未动）。
- **B2 乐观并发已 ship（2026-06-16，6 commit 落 `main` 未 push，手测全过）**，设计/实施记录 `docs/plans/2026-06-16-phase-b2-optimistic-concurrency.md`（v3）：
  `64d8b2f` feat(shared) `patchNote`+`expected_updated_at`（**唯一回流**；daemon 早已支持 CAS）· `e24aa2d` feat(gui) platform `remoteClient` 门 · `3bb31f4` feat(editor) editor-store CAS 基线 + 409→拉远端 · `3de0dc3` feat(editor) `VersionConflictDialog`（覆盖/加载远端/取消）+ folder-drag rebase · `0405c0e` feat(gui) `beforeunload` 脏 tab 守卫（挂 `App.tsx` 会话根，取消自动保存）· `e0cdc6d` docs。
  **ms 从 `Note.updatedAt` ISO 无损派生（未加 `updated_at_ms`）**。**保护模型 = 仅 web editor save**（web 后写者 409；桌面后写仍 LWW + conflict_record，刻意取舍）。
- **B2 验证**：gui **434**（+16：12 editor-store CAS + 4 unload guard）· `just check` 9 守卫/biome/`tsc -b` · `pnpm -r build`+web build · daemon 394/core 529/cli 137 不变 · **云端 rig 手测全过**。**桌面端零回归**（CAS/guard 均 `remoteClient` 门，桌面 PATCH 字节不变）。
- **B1 deferred（仍挂账）**：**apps/web 接 `tsc -b` + dedup `@types/react`** 撞 monorepo project-ref 墙（apps/web 重复 typecheck renderer 图 → 双 @types 身份冲突）→ 独立小任务（功能已由 gui typecheck 全覆盖）。云端 rig 视觉验已于 B2 完成。
- **Phase A/B 基线**：core **529** / daemon **394** / cli **137** / gui **434** + gated e2e **29**；`just check` **9 守卫**。

### 下一步

1. **Phase B 续作**（设计稿 §4 slice）：
   - **⭐ B3（下一会话起点）**：XSS/CSP — `MarkdownPreview` web 分支 `rehype-sanitize`（或去 `rehypeRaw`）+ 外链 `target=_blank rel=noopener`；保 KaTeX/highlight passThrough。倾向 web-only 分支（不动桌面渲染）。cloud web 共享源 + bearer 在 JS → 笔记恶意 HTML 一旦执行即偷 token，B3 必做。
   - **B4**：daemon 静态托管（`@fastify/static` + SPA fallback + CSP + API 路由优先级）。**⭐7 正式版 owl-server 默认端口 47020**（=47010+10；桌面本地 daemon 保持 47010；落地在 B4/Aω）。
   - **B0/B1/B2 ✅ 已完**（B2 已 ship，见上）。B1 deferred 小任务（apps/web 接 `tsc -b`）仍挂账。
2. **Phase A 收尾**：A6（local mutating-token，闭 CSRF）· Aω（发 owl-server + 上云，需重部署 skybridge）· A4 deferred（off grace-quiesce）。
3. **延后的重构一轮**（Step 0 显式延后）：复杂度 warning（含 `useEditorShortcuts` 复杂度 36）+ `>500` 行大文件 + 类型 mirror dedup。
4. **0.6 feature backlog**（arch §11）：W7 冲突双向 · 跨 profile 视图 · `resetAllStores` 免闪烁 · TLS/反代 · 真·24h soak · P6 多设备 GA → 1.0.0。

> **扩生态架构定稿** → `docs/plans/2026-06-06-mobile-web-ecosystem-arch.md`（v6：云端 daemon 共享后端 · RN 移动 · web 先行 · text-first 砍附件）。开发流：Step 0 ✅ → **Phase A** → B 网页版 → C 发 owl-shared → D 移动 v1 → E 移动 v2。

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

## 关键参考

- 跨仓路线：`aviary/docs/ROADMAP.md`
- skybridge 架构框架：`aviary/docs/SKYBRIDGE_ARCH.md`
- per-profile 隔离父设计（v6 定稿）：`docs/plans/2026-05-29-account-profile-isolation-design.md`
- skybridge 本地开发/调试/发布：见 owl `CLAUDE.md` skybridge 段 + `skybridge/docs/deploy/ubuntu-baota.md`
- 历史 P3 总规划（§8 已作废）/ COEDIT 早期规划：`docs/plans/2026-04-20-p3-plan.md` / `docs/plans/COEDIT_PLAN.md`
