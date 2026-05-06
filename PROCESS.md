# 开发进度

## 当前阶段：P3.4 UX 完善 ✅ 完成

**563/563 测试通过**（core 150 + cli 119 + daemon 138 + gui 156）。P3.4 全部 6 子项于 2026-05-05..2026-05-07 shipped。下一步进入 **P4 migration 同步**（发 0.4.0）。

### P3.4 子项状态

| # | 子项 | 规模 | 状态 |
|---|---|---|---|
| **P3.4-a** | 笔记排序模型（置顶 `pinned_at` + 同层级 DnD `position`，0002_sorting.sql 首验 forward migration runner） | 中 | **✅ shipped 2026-05-05** |
| **P3.4-b** | 特殊笔记视觉区分（`#随记` 蓝边框 / `#待办` 粉边框，NoteList + 浏览页） | 小 | **✅ shipped 2026-05-05** |
| **P3.4-c** | AI chat 笔记 id → pill（覆盖裸 UUID / 单反引号 / `[label](uuid)` 三形态，prompt 约束 + FTS5 提示） | 小 | **✅ shipped 2026-05-05** |
| **P3.4-d** | TagBar 输入框 Tab/Enter 区分补全（Tab 纯字面量 / Enter 触发 picker） | 小 | **✅ shipped 2026-05-06** |
| **P3.4-e** | 笔记 tab VSCode 风格（preview 字段 + 斜体 / NoteList 单击预览 / 双击固定 / 上下键预览切换） | 中 | **✅ shipped 2026-05-07** |
| **P3.4-f** | 聊天持久化 + 侧栏布局（schema v3 + ConversationStore SQLite + ChatSidebar + 跨切换流式不断线 + 历史 reasoning/is_error 水合） | 大 | **✅ shipped 2026-05-07** |

各子项 Implementation record：
- P3.4-a：`docs/plans/2026-05-05-p3-4-a-sorting-model-design.md`
- P3.4-b：`docs/plans/2026-05-05-p3-4-b-special-notes-visual-design.md`
- P3.4-c：`docs/plans/2026-05-05-p3-4-c-note-id-pill-design.md`
- P3.4-d：`docs/plans/2026-05-06-p3-4-d-tagbar-tab-enter-design.md`
- P3.4-e：`docs/plans/2026-05-07-p3-4-e-tab-preview-design.md`
- P3.4-f：`docs/plans/2026-05-07-p3-4-f-chat-persistence-design.md`

### 下一步

**P4 migration 同步**：用 TypeScript 重写 rclone bisync 同步工具（原 Go `migration/` 子项目）。范围见 `docs/plans/2026-04-20-p3-plan.md` §8。

动工前先开 design doc 对齐 scope。完成后 P3.4 + P4 一起发 **0.4.0** GitHub Release + `@orpheus-aviary/owl-cli@0.4.0` npm。

## 整体路线

```
P3.4 UX 完善 → P4 migration 同步（发 0.4.0）→ P5 打包/发布自动化 → P6 次要功能集
                                                                     └→ P3.5 可选 MCP server
```

完整规划：`docs/plans/2026-04-20-p3-plan.md`。

**P6 非核心**（届时再定 scope）：tray 图标 / 图片粘贴 / FIM 补全 / `append_memo` 语义 / AI banner option C / `[[` note-link / 编辑器正文 slash command / `owl doctor --recover` / CLI 别名 / `@owl/core` 公开发布 / 0.3.0 rebuild 代码移除。

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

P2-8 / P2-9 手动测试清单分别在 `docs/plans/2026-04-17-p2-8-ai-page.md` 和 `docs/plans/2026-04-20-p2-9-resizable-panels.md` 的附录段。

## 关键参考

- 完整 COEDIT 计划：`docs/plans/COEDIT_PLAN.md`
- 聊天持久化设计（P3.4-f）：`docs/plans/2026-04-18-chat-persistence.md`
- P3 总规划：`docs/plans/2026-04-20-p3-plan.md`
