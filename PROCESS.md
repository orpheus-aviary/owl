# 开发进度

## 当前阶段：🚧 Phase A 云端 daemon 核心 slice 全部完成（A0–A5 2026-06-14，剩 A6 后置 / Aω 另立）

**0.5.0**（per-profile 隔离 + 免密快切）已公开发版（2026-06-06）。**扩生态 Step 0** 已全部完成（2026-06-12，renderer/Electron 解耦 + `@orpheus-aviary/owl-shared`）。
**Phase A = 云端 daemon**（`[daemon].mode` cloud/local + 端点鉴权 + 两层会话）。子设计 + 实施记录 →
`docs/plans/2026-06-12-phase-a-cloud-daemon-design.md`（v2.1，§实施记录有 A0–A5 逐 slice + carry-forward）。

- **Phase A A0–A5 已实现 + 全绿，main 未 push**：`d92b958` **A0**（mode/bind + 6 启动守卫）·
  `ced4e00` **A1**（CORS allowlist + Host 校验）· `8fe81ec` **A2**（`SessionStore` + 端点 auth）·
  `64dbfc0` **A3a**（SDK surface + `switchToProfileId` + `CredentialStore`）· `3ab2b07` **A3b**（cloud 自登录链 + refresh）·
  `2d495e3` **A3c**（`owl-server compute-owner` CLI）· `6ace4a4` docs · `208e767` **A4 core**（`/auth/*` 端点 + 限速 +
  cloud 禁 plumbing + off 抢占闸 + cloud `readSyncStatus` + `/auth/login` 自死锁修复）· `6a9ed5d` **A4 e2e/docs**·
  `39e1f45` **A5**（`GET /config` redaction + `PublicOwlConfig` 投影 + `[llm].*` PATCH owner-gate）。
- **新基线**：core **529** / daemon **394**（+9）/ cli **137** / gui **406** + gated e2e **29**；`just check` **9 守卫**（A5 无新守卫）。
- **桌面端零行为变更**（唯一触及 local = A1 CORS/Host，已 `just dev` 真机验证）。

### 下一步

1. **Phase A 收尾决策点**：核心 slice A0–A5 已完，剩两块都不是「顺势就做」——
   - **A6**（后置，**触桌面全客户端**，显式 override arch §7.6）：local 模式 mutating-token（GUI main 每 boot 生成 → preload 注入 renderer + 落 CLI 可读处；daemon 在 local 也校验 mutating 端点）。闭合 A1–A5 期间仍开的 local cross-site simple-POST CSRF 洞（见 §7「A6 显式 override 说明」+ §10）。需全端手测回归。
   - **Aω**（另立 gated）：发 `@orpheus-aviary/owl-server`（含内嵌 web 包，依赖 Phase B）+ 上云 + 异地真机冒烟，**需先重部署 skybridge**。
   - 或先转 **Phase B 网页版**（开发流：Step 0 ✅ → A ✅(核心) → **B web** → C 发 owl-shared → D 移动 v1 → E v2）。
2. **A4 deferred**：off 模式完整引用计数 grace-quiesce（A4 只做「Y 不顶活着的 X」抢占闸；详见设计稿 §实施记录 A4）。
3. **延后的重构一轮**（Step 0 显式延后）：复杂度 warning + `>500` 行大文件 + 类型 mirror dedup。
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
