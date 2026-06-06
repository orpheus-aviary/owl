# 开发进度

## 当前阶段：🎉 owl 0.5.0 公开发版完成（2026-06-06）；下一步 0.6 / P6

**0.5.0 = per-profile 账号隔离 + 免密快切**（P5-d 主线，Phase 2-23）。已 push 三仓、tag
`v0.5.0`/`cli-v0.5.0`、GitHub Release（`Owl-0.5.0-arm64.dmg`，Latest）、npm
`@orpheus-aviary/owl-cli@0.5.0`=latest。依赖 skybridge server **0.1.4**（npm latest）。

- **最终基线**：core **528** / daemon **290** / cli **137** / gui **399** + gated e2e **25/25**；`just check` 8 守卫全绿。
- **P5-d 完整实施记录已归档** → `docs/history/P5-d-shipped.md`（Phase 索引 + commit 表 + 不变量 + 真机手测 + 基线演进）。
- **用户可见 release notes** → `docs/history/0.5.0-release-notes.md`。

### 下一步：0.6 / P6

计划文档 → `docs/plans/2026-06-06-0.6.0-plan.md`。**首步 = 系统性项目审视/整理**（冗余清理、
死代码、小重构、非功能优化——开发期累积的计划外内容阶段性整理），之后再排 feature backlog
（W7 冲突双向解决/合并 · W11 附件同步 · 跨 profile 视图 · `resetAllStores` 免闪烁 · TLS · 真·24h soak
· P6 skybridge Phase 5 多设备 GA → owl 1.0.0）。详见 0.6.0 plan + 设计稿 §11「0.5.0 之外」。

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
