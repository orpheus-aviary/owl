# 开发进度

## 当前阶段：🚧 Phase B 网页版进行中（B0 完成 2026-06-14；Phase A 核心 A0–A5 已完）

**0.5.0**（per-profile 隔离 + 免密快切）已公开发版（2026-06-06）。**扩生态 Step 0** 已全部完成（2026-06-12，renderer/Electron 解耦 + `@orpheus-aviary/owl-shared`）。
**Phase A = 云端 daemon** 核心 slice **A0–A5 已完**（cloud/local 模式 + 端点鉴权 + 两层会话 + `/auth/*` + config redaction）；
剩 A6（后置，触桌面全客户端，闭 local CSRF）· Aω（发 owl-server + 上云）。
**Phase B = 网页版**（`apps/web` 瘦客户端复用 renderer 树）。子设计 → `docs/plans/2026-06-14-phase-b-web-design.md`（v1，⭐1/2/4 已拍板）。

- **Phase B B0 已实现 + 全绿，main 未 push**：`d499d33` docs 设计稿 · `697afd8` **B0**（`apps/web` Vite 脚手架：
  `@` alias 到 `packages/gui/src/renderer/src` + 挂 `<App/>`；runtime `getPlatform()` 在浏览器返 webAdapter；Tailwind v4 content
  指向 renderer 源 + React dedupe；dev proxy 转发 daemon API 保同源；`just dev-web`）。
- **B0 验证**：`pnpm --filter @owl/web build` 出静态包（Tailwind 1143 规则生成）· `just check` 全绿 · dev smoke
  （`:5274` 服务 index.html + proxy `/status`·`/notes` 转发到隔离 daemon + entry `/@fs/` transform）。**桌面端零变更**。
- **B0 限制（B1 跟进）**：`apps/web` 暂未进 `tsc -b`（renderer 真身已由 `gui/tsconfig.web.json` typecheck）；standalone typecheck
  撞 dual-`@types/react` 类型身份冲突（esbuild build 无视、运行时 dedupe 已处理）→ B1 长出 web 组件时一并 dedup 接入 CI。
- **Phase A 基线**：core **529** / daemon **394** / cli **137** / gui **406** + gated e2e **29**；`just check` **9 守卫**。

### 下一步

1. **Phase B 续作**（设计稿 §4 slice）：
   - **B1**：webAdapter 6 sync 方法换真 HTTP（`/auth/login`·logout·session·`/sync/status`·run·devices）+ token 内存态 +
     `configureTransport` 注 bearer + 401→登录屏 + 登录态机（复用 `LoginForm`）。**此片同时把 apps/web 接入 `tsc -b` + dedup `@types/react`。**
   - **B2**：乐观并发（`patchNote` 加 `expected_updated_at` + `Note.updatedAt` ms 对齐，倾向新增 `updated_at_ms` 不动现 string）
     + 409 拉远端提示 + 自动保存。**唯一回流 shared/daemon，桌面 PATCH 须零回归。**
   - **B3**：XSS/CSP（`MarkdownPreview` web 分支 `rehype-sanitize` + 外链 noopener）。
   - **B4**：daemon 静态托管（`@fastify/static` + SPA fallback + CSP + API 路由优先级）。
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
