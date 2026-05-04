# P3.0.5 — Pre-release 修复打磨（2026-04-28，7/7 完成）

P3.1 打包 `0.2.0` 之前的最后一轮 bug 修复和 UX 打磨。7 项 + 跨页 stale-list bus 重构。

## Commit 表

| 项 | 内容 | Hash |
|---|---|---|
| docs | P3.0.5 范围细化 + 双 adapter thinking 协议表 | `162a319` |
| #10 | 拖到"未分类"区域 drop 失效 — UnfiledSection 接 useDroppable + footer 文案按拖拽类型切换 | `40bc340` |
| #4 | 回收站恢复后文件夹树 / 主笔记列表未刷新 | `8f0df50` |
| #4b | 跨页 stale list 统一刷新 — 新增 `stores/data-bus.ts`，note/folder/browser store 模块级订阅；附带修复 Bug A（save 后 folder tree 标题不变）+ Bug B（FolderPanel 删笔记后 TrashPage 不刷新） | `10dbee3` |
| #9/#6/#7 | 滚动条 gutter 暗色 + 列表正文白色 + Bold/Italic 快捷键 toggle 语义（Cmd+E 让位给 useEditorShortcuts 的"聚焦编辑区"） | `76d8937` |
| #3 | AI thinking 协议修复 — 双 adapter（OpenAI `delta.reasoning_content` + Anthropic `thinking_delta` / `signature_delta`）+ agent-loop 累积 + GUI 折叠显示 + Settings `thinking_round_trip` toggle | `7999a01` |
| #2 | DraftReadyCard 折叠 + 单卡"同意"（Tier-1，跳过 editor）+ "同意全部 (N)" 批量按钮 + 冲突检测 / per-card 错误隔离 | `b038d2e` |

## 完成后基线

- 测试：228 个全部通过（core 84 + daemon 95 + gui 49）
- Lint + Typecheck：零错误（11 个 pre-existing warnings）

## 从本批移出的项

| 项 | 去向 | 理由 |
|---|---|---|
| #11 同层级笔记拖拽排序 | P3.4-a（合并到排序模型） | 经查不是 regression 而是缺失功能 — 笔记无 `position` 字段；需 schema + daemon API + GUI gap drop target |
| #1 图片粘贴 + 缓存目录 | P6 | 原本就在 P3.4+ |
| #5 VSCode 风格 tab | P3.4-e | 原本就在 P3.4+ |
| #8 FIM 补全 | P6 | 原本就在 P3.4+ |

## 关键产物（延续至后续阶段）

- **`stores/data-bus.ts`** — 跨页 list 刷新基础设施。新增任何 mutation 都必须调 `bumpNotes()` / `bumpFolders()`。记忆: `feedback_data_bus_pattern.md`
- **双 adapter thinking 协议** — OpenAI `delta.reasoning_content` + Anthropic `thinking_delta`/`signature_delta`；配置 `[llm].thinking_round_trip: bool`（默认 true，DeepSeek V3 reasoner / OpenAI o-series chat 用户需手动改 false）。记忆: `project_thinking_protocols.md`
- **DraftReadyCard Tier-1 路径** — 同意 button 走 REST API 直接写，与 `打开` (Tier-2) 并存；冲突检测 refuses overwrite 时回退到打开。记忆: `project_p2_8_chat_decisions.md`
