# 开发进度

## 当前阶段：0.4.1 hotfix 已 ship — 下一步 P5（skybridge server + sync engine）

**600/600 测试通过**（core 187 + cli 119 + daemon 138 + gui 156）。P3.4 + P4 Phase 1+2 全部 shipped，2026-05-08 发 0.4.0；2026-05-09 发 GUI 0.4.1 hotfix（修复 macOS Sequoia 上 dmg 安装后报"已损坏"，原因是 electron-builder `identity: null` 跳过了 bundle-level codesign，新增 `afterPack` 钩子做 ad-hoc 签名）：

- GUI 0.4.1 Release：https://github.com/orpheus-aviary/owl/releases/tag/v0.4.1（`Owl-0.4.1-arm64.dmg`，sha256 `be62243b...67e23b7`）
- GUI 0.4.0（已废）：https://github.com/orpheus-aviary/owl/releases/tag/v0.4.0
- CLI npm：`npm i -g @orpheus-aviary/owl-cli`（@0.4.0，hotfix 仅改 GUI 打包，CLI 不受影响）
- 实施细节：`docs/history/P3-4-P4-shipped.md`

### 下一步

**P5 skybridge Phase 3+4**（发 0.5.0）：
- **Phase 3** — skybridge server 首发：HTTP push/pull endpoints、device 注册、`sync_changes` apply 引擎
- **Phase 4** — owl 端 sync engine：HTTP client + SSE 订阅 + 后台 push/pull/定时/网络恢复触发 + GUI 同步状态栏

跨仓架构 `aviary/docs/SKYBRIDGE_ARCH.md`。开工前在 skybridge 仓单独拉 server design doc，然后 owl 端拉 P5 phase 3/4 各自的 design doc。

## 整体路线

```
P3.4 UX 完善 ✅ + P4 skybridge Phase 1+2 ✅ → 0.4.0 发版完成
  → P5 skybridge Phase 3+4（server 首发 + 后台 sync，发 0.5.0）
  → P6 skybridge Phase 5（多设备 GA，发 1.0.0 候选）
  → P7 打包 / 发布自动化
  → P8 次要功能集
  └→ P3.5 可选 MCP server（任意时刻并行）
```

完整规划：`aviary/docs/ROADMAP.md`（跨仓路线）、`docs/plans/2026-04-20-p3-plan.md`（owl 历史 P3 规划，§8 已作废）。

**P8 非核心**（原 "P6 非核心"，届时再定 scope）：tray 图标 / 图片粘贴 / FIM 补全 / `append_memo` 语义 / AI banner option C / `[[` note-link / 编辑器正文 slash command / `owl doctor --recover` / CLI 别名 / `@owl/core` 公开发布 / 0.3.0 rebuild 代码移除。

## 历史归档

每个已 ship 阶段的实施细节都收在对应设计文档的 `## Implementation record` 段，或 `docs/history/` 下的专题 doc：

| 阶段 | 位置 |
|---|---|
| P0 / P1 基础搭建 | `docs/history/P0-P1-shipped.md` |
| P2 功能完善 | `docs/history/P2-shipped.md`（含 commit 表 + 设计文档引用） |
| P3.0.5 pre-release polish | `docs/history/P3-0-5-shipped.md` |
| P3.1 GUI 0.2.0 首发 | `docs/plans/2026-04-28-p3-1-gui-0.2.0-release-design.md` § Implementation record |
| P3.2-a migration runner | `docs/plans/2026-04-29-p3-2-a-migration-runner-design.md` § Implementation record |
| P3.2-b MigrationDialog | `docs/plans/2026-04-30-p3-2-b-migration-dialog-design.md` § Implementation record |
| P3.2-c CLI 核心 | `docs/plans/2026-05-02-p3-2-c-cli-core-design.md` § Implementation record |
| P3.2-d SSE 反向通道 | `docs/plans/2026-05-02-p3-2-d-events-channel-design.md` § Implementation record |
| P3.2.5 release polish | `docs/plans/2026-05-03-p3-2-5-design.md` § Implementation record |
| P3.3 0.3.0 发版 | `docs/history/P3-3-shipped.md` |
| P3.4 UX 完善 + P4 skybridge Phase 1+2 + 0.4.0 发版 + 0.4.1 hotfix | `docs/history/P3-4-P4-shipped.md` |

P2-8 / P2-9 手动测试清单分别在 `docs/plans/2026-04-17-p2-8-ai-page.md` 和 `docs/plans/2026-04-20-p2-9-resizable-panels.md` 的附录段。

## 关键参考

- 跨仓路线（skybridge 对接上下文）：`aviary/docs/ROADMAP.md`
- skybridge 架构框架：`aviary/docs/SKYBRIDGE_ARCH.md`
- owl P4 skybridge 对接计划：`docs/plans/2026-05-07-p4-skybridge-plan.md`（已 ship，docs/history 里有完整记录）
- 完整 COEDIT 计划：`docs/plans/COEDIT_PLAN.md`
- 聊天持久化设计（P3.4-f）：`docs/plans/2026-04-18-chat-persistence.md`
- P3 总规划（§8 已作废）：`docs/plans/2026-04-20-p3-plan.md`
