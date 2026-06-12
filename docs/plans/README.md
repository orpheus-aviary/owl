# docs/plans — 设计稿索引

owl 各阶段的**子设计文档**，文件名按 `YYYY-MM-DD-<主题>.md` 编号（沿用 P5-d 习惯：每阶段开工前拉独立设计稿）。

## 怎么找

- **已 ship 阶段的实施记录** → `PROCESS.md` 顶部「历史归档」表 + `docs/history/*-shipped.md`（P0–P5-d 的归档索引）。
- **当前/进行中** → `PROCESS.md`「当前阶段」段。
- **跨仓路线** → `aviary/docs/ROADMAP.md`；**同步架构** → `aviary/docs/SKYBRIDGE_ARCH.md`。

## 活跃稿（未 ship / 当前路线）

- `2026-06-06-mobile-web-ecosystem-arch.md` — 扩生态架构（web + 移动，v6 定稿）
- `2026-06-06-0.6.0-plan.md` — 0.6.0 路线（Step 0 清理 + feature backlog）
- `2026-06-12-step0-platform-adapter-shared.md` — Step 0 子设计（平台适配 + owl-shared + fetch-SSE）
- `2026-06-12-0.6.0-cleanup-findings.md` — Step 0 cleanup 发现清单 + triage

## 已作废 / 纯历史

- `COEDIT_PLAN.md` — owl Go→TS 重写 + migration 早期规划，**已作废**（顶部有标注）
- `2026-04-20-p3-plan.md` — P3 完整规划，**已 ship**（§8 作废，顶部有标注）
- 其余 `2026-04-*` ~ `2026-06-*` 各 PN/phase 设计稿 = 对应阶段已 ship 的历史参考；实施细节见上述 history 归档。
