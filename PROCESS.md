# 开发进度

## 当前阶段：🚧 Phase A 云端 daemon 进行中（A0–A3 完成 2026-06-13，下一步 A4）

**0.5.0**（per-profile 隔离 + 免密快切）已公开发版（2026-06-06）。**扩生态 Step 0** 已全部完成（2026-06-12，renderer/Electron 解耦 + `@orpheus-aviary/owl-shared`）。
**Phase A = 云端 daemon**（`[daemon].mode` cloud/local + 端点鉴权 + 两层会话）。子设计 + 实施记录 →
`docs/plans/2026-06-12-phase-a-cloud-daemon-design.md`（v2.1，§实施记录有 carry-forward + A4 scope）。

- **Phase A A0–A3 已实现 + 全绿，6 commit（main，未 push）**：`d92b958` **A0**（mode/bind + 6 启动守卫）·
  `ced4e00` **A1**（CORS allowlist + Host 校验）· `8fe81ec` **A2**（`SessionStore` + 端点 auth）·
  `64dbfc0` **A3a**（SDK surface + `switchToProfileId` + `CredentialStore`）· `3ab2b07` **A3b**（cloud 自登录链 + refresh）·
  `2d495e3` **A3c**（`owl-server compute-owner` CLI）。
- **新基线**：core **529** / daemon **364** / cli **137** / gui **406** + gated e2e **25**；`just check` **9 守卫**（+`cloud-creds-no-disk`）。
- **桌面端零行为变更**（唯一触及 local = A1 CORS/Host，已 `just dev` 真机验证）。Step 0 的 11 守卫数与本计数不同源（本处指 daemon shell 守卫链）。

### 下一步

1. **Phase A4（capstone）**：`POST /auth/login`·`/auth/logout`·`GET /auth/session`（wire `cloudLogin` + 铸 Layer-2 + 限速）·
   **cloud 禁用 `/sync/session`+`/sync/switch`+`/sync/logout-local`** · `account_lock=off` 释放规则（查活跃 session）·
   `readSyncStatus` cloud 状态源（CredentialStore，非 toml）· **真·本地 skybridge 端到端冒烟**。详见设计稿 §实施记录「A4」。
2. **Phase A 之后**：A5（`GET /config` redaction + `PublicOwlConfig`）· A6（local mutating-token，后置，触桌面全客户端）· Aω（发 owl-server + 上云，需先重部署 skybridge）。
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
