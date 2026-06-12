# 开发进度

## 当前阶段：✅ 扩生态 Step 0 全部完成（2026-06-12）；下一步 Phase A 云端 daemon

**0.5.0**（per-profile 隔离 + 免密快切）已公开发版（2026-06-06，三仓 push / tag / GitHub Release /
npm `@orpheus-aviary/owl-cli@0.5.0`=latest，依赖 skybridge server **0.1.4**）。
**扩生态 Step 0** = 让 renderer 与 Electron 解耦、抽出 `@orpheus-aviary/owl-shared`，为 web/移动铺路。

- **Step 0 子设计** → `docs/plans/2026-06-12-step0-platform-adapter-shared.md`（§实施记录）。findings → `…-0.6.0-cleanup-findings.md`。
- **Step 0 7 commit（main，未 push）**：`cfe76cf` 子设计 · `1a5e561` **0a** 平台适配（`getPlatform()`+G10）·
  `b190a4c` **0b-1** owl-shared（api client+类型+transport+G9）· `0c5d1ac` **0b-2** fetch-SSE 全切（`subscribeSse` 重连，真机验证）·
  `2ee659a` **0c** findings+文档 hygiene · `1757eb4` **0d** lint（warnings 53→20）· `eb48c17` **0d** de-export `requireAuth`。
- **新基线**：core **528** / daemon **290** / cli **137** / gui **406**（+7 SSE 测试）+ gated e2e 25；`just check` **11 守卫**（+G9 owl-shared-mobile-safe / +G10 renderer-owlapi-confined）；biome warnings **20**（全是延后的 `noExcessiveCognitiveComplexity`）。
- **新增 `packages/shared`** = `@orpheus-aviary/owl-shared`（private，Phase C 发布）：`types`/`transport`/`client`/`sse`。

### 下一步

1. **Phase A — 云端 daemon**（扩生态主线，拉独立子设计稿）：`[daemon].mode` cloud/local + 端点鉴权 + CORS allowlist + Host 校验 + mutating 请求认证（daemon auth provider 覆盖 CLI/GUI/web）+ bind 矩阵 + 启动守卫 + 两层会话 + `account_lock` + 凭据内存态 + daemon 自发起 login/registerDevice/ensureWorkspace + `GET /config` secret redaction。详见 arch §3/§7/§12。
2. **延后的重构一轮**（Step 0 显式延后，同源）：20 个复杂度 warning + 8 个 `>500` 行大文件（`sync-auth.ts` 1042 / `engine.ts` 1040 / …）+ 类型 mirror dedup。
3. **0.6 feature backlog**（设计稿 §11）：W7 冲突双向解决/合并 · 跨 profile 视图 · `resetAllStores` 免闪烁 · TLS/反代 · 真·24h soak · P6 skybridge Phase 5 多设备 GA → owl 1.0.0。

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
