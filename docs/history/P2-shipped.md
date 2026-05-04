# P2 Shipped

功能完善：待办 / 设置 / 文件夹 / AI 对话 / 分屏拖拽 / 提醒清理。P2 完成后测试 212 个全绿（core 84 + daemon 93 + gui 35，基线，P3 期间进一步增长）。

## P2 commit 分解（11 步）

| # | 内容 | 类型 |
|---|------|------|
| P2-0 | 待办页面（提取+分组+勾选同步，含 openTabs 冲突处理） | 前端+API |
| P2-1 | 设置页面框架 + 快捷键自定义栏 | 前端+API |
| P2-2 | 设置 — 外观栏 | 前端+配置 |
| P2-3 | 设置 — 自定义栏（LLM API + 自动删除天数 + 默认模式/排序） | 前端+配置 |
| P2-4 | 设置 — 高级栏（LLM 参数 + 日志） | 前端+配置 |
| P2-5a | 文件夹核心 + daemon API（CRUD + 递归 CTE + 移动笔记） | Core+API |
| P2-5b | GUI 文件夹侧边面板（树 + 右键 CRUD + Cmd+B + context-menu） | 前端 |
| P2-5c | 拖拽（dnd-kit 排序 + 拖笔记入文件夹 + editorStore.folderId 同步） | 前端 |
| P2-6 | 浏览页文件夹筛选（include_descendants） | 前端 |
| P2-7a | LLM client SDK 适配器 | 后端 |
| P2-7b | Tool registry + 9 工具（read + Tier-1 write） | 后端 |
| P2-7c | Agent loop + 内存对话 + system-prompt（Layer 1 recent fill） | 后端 |
| P2-7d | SSE 端点 `/ai/chat` + AI 路由 + AppContext 扩展 | 后端 |
| P2-7e | Tier-2 写工具（create/update_note、create_reminder、apply_update）+ draft/preview | 后端 |
| P2-8 | AI 对话页面（聊天界面 + 草稿机制） | 前端 |
| P2-9 | 分屏拖拽（列表↔编辑、编辑↔预览、含 FolderPanel） | 前端 |
| P2-10 | reminder_status 清理（90 天 fired 记录） | 后端 |

## 详细 commit hash 表

| Commit | 内容 | Hash |
|--------|------|------|
| P2-0 | 待办页面（提取+分组+勾选同步+dirty tab overlay） | `1bd0889` |
| P2-1 | 设置页面框架 + 快捷键自定义栏（daemon /config API + 12 项快捷键录制） | `dba637b` |
| P2-2 | 设置 — 外观栏（窗口大小 + 全局字体偏移 + 编辑器字号/行高，CSS 变量） | — |
| P2-3 | 设置 — 自定义栏（LLM API + 测试连接 + auto_delete_days + 默认模式/排序） | `73e7ea0` |
| P2-4 | 设置 — 高级栏（AI 上下文参数 + 日志配置 + 日志级别切换） | `88b9079` |
| fix | trash sticky-deadline（auto_delete_at 列 + 非递增语义 + 独立 cleanup timer + daemon /config 值校验 + GUI ESM spawn 修复） | `d70428a` |
| P2-5a | folders 核心模块 + 递归 CTE + daemon `/folders`/`/notes/:id/move` 路由 | `44ea48d` |
| P2-5b | GUI 文件夹侧边面板（树 + 右键 CRUD + Cmd+B toggle + editor-scoped） | `fa6d225` |
| P2-5c | 拖拽（dnd-kit 排序 + 跨父级 move + 拖笔记入文件夹 + cycle 抑制 + 双击展开） | — |
| P2-7a | LLM client SDK 适配器（OpenAI + Anthropic 双 SDK，统一 StreamChunk 异步流） | `7424c38` |
| P2-7b | Tool registry + 9 个工具（7 read + 2 Tier-1 write）+ WriteToolResult 契约 | `f5ff159` |
| P2-7c | Agent loop + ConversationStore + 系统提示（Layer 1 recent fill）+ max_context_chars 配置 | — |
| P2-7d | SSE 端点 + AI 路由（POST /ai/chat、GET/DELETE /ai/conversations、GET /ai/capabilities）+ AppContext 扩展 | — |
| P2-7e | Tier-2 写工具（create/update_note、create_reminder、apply_update）+ PreviewStore + GUI editorStore 草稿/暂存 | — |
| docs | P2-8 计划文档 + P2-7 计划同步实际事件契约 + PROCESS daemon-restart 历史引用清理 | `8717e6a` |
| P2-8 step 1 | SSE client (`lib/sse-client.ts`) + 9 vitest 测试（GUI 首个测试 runner） | `74c1027` |
| P2-8 step 2 | `/ai/*` HTTP wrappers + ai-store skeleton（newChat/closeChat/abortStreaming + sendMessage 完整 SSE wiring） | `b583630` |
| P2-8 step 3 | 纯函数事件 dispatcher (`ai-dispatcher.ts`)，处理全部 9 类事件 + 14 个 vitest 测试 | `c8bfc86` |
| P2-8 step 4 | AIPage shell + ChatTabBar + MessageList + MessageBubble + ChatInput | `a830fa0` |
| P2-8 step 5 | ToolCallBlock + DraftReadyCard + PreviewReadyCard + 嵌入 MessageBubble | `b335951` |
| P2-8 step 6 | `editorStore.applyNoteAppliedFromAi` + ai-store 转发 + 全局 NoteAppliedToast + 4 个 vitest 测试 | — |
| P2-8 step 7 | DraftReadyCard "打开" → `openAiDraft / stageAiUpdate` + `markDraftOpened` + navigate | `54d87c8` |
| P2-8 step 8 | `@codemirror/merge` 集成 + `components/ai/diff/DiffView.tsx`（read-only split） | `bf16c9d` |
| P2-8 step 9 | `conflictPrompt` + `requestSaveOrConflict` / `resolveConflict` + `<ConflictDialog>` 嵌入 DiffView + 5 个 vitest 测试 | `a993c3c` |
| P2-8 step 9 fix | pre_stage_content 捕获（dirty-stage 触发冲突） + accept-ai 清 pre_stage 避免重试循环 + daemon `setErrorHandler` 把 500 stack 写进 log | `0e7cca5` `c53dbb0` |
| P2-8 step 10 | ChatInput 自动聚焦（mount / chat 切换 / stream 结束）+ abort 后显示"⏹ 已停止生成"指示 + E2E 手动测试清单 | `a3b924d` |
| P2-9 设计 | 3 个 Group（FolderPanel↔main / NoteList↔编辑区 / Editor↔Preview） | `353e821` |
| P2-9 step 1 | `react-resizable-panels@4` + `components/ui/ResizeHandle.tsx`（Separator 包装） | `9953859` |
| P2-9 step 2 | `App.tsx` 外层 Group（FolderPanel 改 collapsible Panel，Cmd+B 走 imperative collapse/expand，main 不再 remount） | `c0db35b` |
| P2-9 step 3 | `EditorPage.tsx` NoteList↔编辑区 Group；UnsavedDialog hoist 出 Group 避免非法子节点 | `831e7a9` |
| P2-9 step 4 | `EditorPanel.tsx` split 模式 Editor↔Preview Group，切换模式/刷新都保留比例 | `98152de` |
| P2-9 fix | Panel size props 单位字符串化（minSize `"120px"`），过滤 collapsed=0 的 save，panelOpen 持久化到 localStorage | `11116a6` `da43e8b` |
| P2-10 | `cleanupOldFiredReminders(db, 90)` + scheduler 集成 + 2 个 core 测试 | `f61253c` |
| P2-6 | 浏览页文件夹筛选：UI 早在 `ad6db40` 随文件夹面板一并做完；本次显式化 `include_descendants` 参数 + 加 daemon 组合测试 | `ad6db40` `1db27cc` |

## P2 完成后基线

- 测试：212 个全部通过（core 84 + daemon 93 + gui 35）
- Lint + Typecheck：零错误（11 个 pre-existing warnings）

## P2 关键设计决策

- AI 草稿走 SSE 响应事件，GUI 自行打开 Tab（无反向通道）
- `create_note` 用 `draft_<uuid>` 占位 ID，首次 Cmd+S 走 POST
- `update_note` dirty 冲突弹 modal 三选一（接受 AI / 保留本地 / 查看差异）
- 待办页数据 = daemon 结果 + dirty tab overlay，订阅 editorStore 自动合并

## P2 当时延后的事项（后续分配）

| 项 | 去向 |
|---|---|
| 远程连接（原 P2-1）— 与 P4 migration 同步机制耦合 | P4 |
| `open_note_in_gui`（daemon→GUI 反向通道） | ✅ P3.2-d shipped |
| 聊天持久化 + 侧栏（删 ChatTabBar 改成侧栏布局） | P3.4-f |
| 特殊笔记视觉区分（pin / badge / 侧栏快捷入口） | P3.4-b（不含侧栏快捷） + P3.4-a（所有笔记可置顶） |
| `append_memo` 语义是否跟随 `#memo` 标签笔记 | P6 |
| 编辑器自动补全（tag / datetime / note-link） | P3.4-d（仅 TagBar） + P6（编辑器正文 + note-link） |
| AI 聊天 → 跳转打开指定笔记（note citation / `open_note` 工具） | P3.4-c |
| Semantic search / embeddings | P4 (评估) |
| AI 草稿 banner-instead-of-overwrite（option C） | P6 |

## P2 关键设计文档

- `docs/plans/2026-04-12-p2-design.md` — P2 总设计
- `docs/plans/2026-04-14-trash-sticky-semantics.md` — 回收站 sticky 语义
- `docs/plans/2026-04-15-p2-5c-dnd-design.md` + `-plan.md` — 拖拽
- `docs/plans/2026-04-17-p2-7-ai-implementation.md` — AI 实施
- `docs/plans/2026-04-17-p2-8-ai-page.md` — AI 对话页（含 P2-8 E2E 手动测试清单 appendix）
- `docs/plans/2026-04-18-chat-persistence.md`（未执行，排 P3.4-f）
- `docs/plans/2026-04-20-p2-9-resizable-panels.md` — 分屏拖拽（含手动测试清单 appendix）
