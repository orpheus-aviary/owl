# 开发进度

## 当前状态：P2 实施中（P2-7 完成 → P2-8 进行中：steps 1-9 / 10 已完成）

### 已完成

| Commit | 内容 | Hash |
|--------|------|------|
| P0-1 | monorepo 初始化 (pnpm workspace + biome + tsconfig) | `42ad912` |
| P0-2 | @owl/core 数据库层 (drizzle + FTS5 + 专项笔记) | `9fdd9f1` |
| P0-3 | @owl/core 配置 + 日志 (TOML + pino) | `cc4b76b` |
| P0-4 | @owl/core 笔记 CRUD + 标签解析 + 搜索 | `b950e8e` |
| P0-5 | @owl/daemon Fastify REST API (15 endpoints) | `e6fbe69` |
| P0-6 | @owl/gui Electron 空壳 (7 页面占位) | `840c164` |
| - | justfile | `8bbcf0d` |
| bugfix | 自动提取标签 + FTS5 trigram 中文搜索 + /time: 冒号格式 | `ead7014` `0ae1f83` `3dfc4b1` |
| P1-0 | 回滚 extractTagsFromContent，标签栏为唯一标签源 | `25bec4b` |
| P1-1 | shadcn/ui + API 调用层 + lucide-react 侧边栏 | `b9f4bb8` |
| P1-2 | zustand stores + 笔记列表 + CORS | `9b9a946` |
| P1-3 | CodeMirror 6 编辑器 + 语法高亮 + 列表续行 | `fadc527` |
| P1-4 | Markdown 渲染组件 + 外部链接 + 脚注 + 数学公式 | `eaebf96` |
| P1-5a | 编辑页面 — 三栏布局 + 多标签 + 模式切换 | `4aaaf9c` |
| P1-5b | 快捷键 + 手动保存 + 脏标记 + 未保存弹窗 | `577b2fe` |
| P1-6 | 标签栏 Tag Bar（输入+自动补全+日期选择器+排序+唯一性） | `401e671` `7b6bdef` `90aa594` `3141eba` |
| P1-7 | 浏览页面（搜索+标签筛选+排序+单击选中+双击打开） | `37d8193` |
| P1-8 | 回收站页面（两Tab+批量操作+倒计时+删除功能） | `7dbf409` |
| 补充 | Cmd+1-7 导航快捷键 + AI 排序调整 + 拖动修复 | `f4119d4` |
| 补充 | 删除关闭Tab + 列表自动滚动到活跃笔记 | `defb0ac` |
| 补充 | 编辑器Backspace误触修复 + 语法高亮增强 | `2d7b1f9` |
| 补充 | 行号3位宽度 + 滚动到底(scrollPastEnd) | `7231b81` |
| P1-9 | 提醒页面（alarm筛选+周期计算+时间范围+编辑） | `997173d`~`03eb7c8` |
| 补充 | 全页面标签显示增强：所有标签类型+可编辑time/alarm | `3928a05` |
| 补充 | 统一标签排序（#拼音→/alarm→/time→频率） | `47ccf9d` |
| 补充 | 多频率同时生效+频率排序修复 | `f04979b` |
| 补充 | 代码简化：提取TagDisplay/date-format/useMemo优化 | `03eb7c8` |
| P1-10 | reminder_status 表 + daemon 提醒调度器 + 系统通知 | `e28c27b`~`948b24b` |
| fix | daemon 测试挂死修复（scheduler.stop() 到 after hook） | `72f05e6` |
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
| P2-8 step 9 | `conflictPrompt` + `requestSaveOrConflict` / `resolveConflict` + `<ConflictDialog>` 嵌入 DiffView + 5 个 vitest 测试 | — |

- 测试：206 个全部通过（core 82 + daemon 92 + gui 32）
- Lint + Typecheck：零错误（11 个 pre-existing warnings）
- 决策文档：`docs/plans/2026-04-14-trash-sticky-semantics.md`、`docs/plans/2026-04-17-p2-7-ai-implementation.md`、`docs/plans/2026-04-17-p2-8-ai-page.md`

### 下一步：P2-8 step 10（Polish — empty-state / shortcut / abort UI / error bubble / E2E 手动测试）

### 本轮会话额外落地（计划外但必需）

- daemon SSE：`reply.raw.on('close')` 替换 `req.raw.on('close')`（后者会在请求 body 读完就触发 → 几毫秒内就 abort agent loop）；`initSse` 内联 CORS echo（`reply.hijack()` 跳过了 `@fastify/cors` onSend）
- GUI：`sse-client.ts` 初始 fetch 阶段也吞 abort；`just dev` 自动拉起 daemon（gui 加 `@owl/daemon` workspace dep + daemon `./cli` 改两 condition 兼容 `createRequire`）
- 特殊笔记：`ensureSpecialNotes` 增加"从回收站恢复"分支；`deleteNote` / `permanentDeleteNote` 拒绝；daemon 路由 403 `SPECIAL_NOTE_PROTECTED`；GUI 删除流程前置检查 → 弹"系统笔记无法删除"对话框（不再静默失败）
- 嵌套 button 水合错误：`TabBar` / `ChatTabBar` / `NoteListItem` 外层改成 `<div role="button">`
- `openNote` 已存在 tab 分支也用 API 新数据刷新内容（脏 tab 只改 baseline）
- ChatInput：裸 Enter 发送 + Shift+Enter 换行（`nativeEvent.isComposing` IME 保护）
- MessageList：`scrollByChatId` 持久化每个 chat 的 scrollTop + `atBottomRef` sticky auto-scroll
- MessageBubble：tool_call / drafts / previews 渲染在 content 前（时间顺序）
- AIPage：React 19 StrictMode 双触发只建一个 chat（`useAiStore.getState()` 读实时状态）
- 配置：删 dead field `max_fts_notes`（daemon 从未用过），Advanced 面板新增"上下文字符预算"（真正的 Layer-1 预算 `max_context_chars`）

### 已落计划文档（本轮新增）

- `docs/plans/2026-04-18-chat-persistence.md` — 聊天持久化 + 侧栏设计（daemon SQLite 存储，删掉 ChatTabBar，类 Claude 网页风格，允许后台 streaming）；**暂不执行**，排在 P2-8 step 8-10 后或 P3
- `docs/plans/p3-deferred.md` — 特殊笔记可视化区分 + `append_memo` 语义讨论 + 聊天历史深度优化，统一归 P3

**P2-8 实施进度（10 步）：**

| Step | 内容 | 状态 |
|------|------|------|
| 1 | `lib/sse-client.ts` + 9 vitest 测试 | ✅ |
| 2 | `lib/api.ts` `/ai/*` wrappers + `ai-store` skeleton（newChat/closeChat/sendMessage） | ✅ |
| 3 | `ai-dispatcher.ts` 纯函数 + 14 个事件测试（9 类事件全覆盖 + malformed/unknown） | ✅ |
| 4 | AIPage shell + ChatTabBar + MessageList + MessageBubble + ChatInput | ✅ |
| 5 | ToolCallBlock + DraftReadyCard + PreviewReadyCard + 嵌入 MessageBubble | ✅ |
| 6 | `editorStore.applyNoteAppliedFromAi` + NoteAppliedToast（store onEvent wrapper 触发） | ✅ |
| 7 | DraftReadyCard "打开" → `editorStore.openAiDraft / stageAiUpdate` wiring | ✅ |
| 8 | `@codemirror/merge` 集成 + DiffView 组件 | ✅ |
| 9 | ConflictDialog + `editorStore.requestSaveOrConflict / resolveConflict` | ✅ |
| 10 | Polish: empty-state、scroll、shortcut、abort UI、error bubble、E2E manual test | ⏳ |

**P2 设计文档：** `docs/plans/2026-04-12-p2-design.md`、`docs/plans/2026-04-17-p2-8-ai-page.md`

P2 commit 分解（11 步）：

| # | 内容 | 类型 | 状态 |
|---|------|------|------|
| P2-0 | 待办页面（提取+分组+勾选同步，含 openTabs 冲突处理） | 前端+API | ✅ |
| P2-1 | 设置页面框架 + 快捷键自定义栏 | 前端+API | ✅ |
| P2-2 | 设置 — 外观栏 | 前端+配置 | ✅ |
| P2-3 | 设置 — 自定义栏（LLM API + 自动删除天数 + 默认模式/排序） | 前端+配置 | ✅ |
| P2-4 | 设置 — 高级栏（LLM 参数 + 日志） | 前端+配置 | ✅ |
| P2-5a | 文件夹核心 + daemon API（CRUD + 递归 CTE + 移动笔记） | Core+API | ✅ |
| P2-5b | GUI 文件夹侧边面板（树 + 右键 CRUD + Cmd+B + context-menu） | 前端 | ✅ |
| P2-5c | 拖拽（dnd-kit 排序 + 拖笔记入文件夹 + editorStore.folderId 同步） | 前端 | ✅ |
| P2-6 | 浏览页文件夹筛选（include_descendants） | 前端 | ⏳ |
| P2-7a | LLM client SDK 适配器 | 后端 | ✅ |
| P2-7b | Tool registry + 9 工具（read + Tier-1 write） | 后端 | ✅ |
| P2-7c | Agent loop + 内存对话 + system-prompt（Layer 1 recent fill） | 后端 | ✅ |
| P2-7d | SSE 端点 `/ai/chat` + AI 路由 + AppContext 扩展 | 后端 | ✅ |
| P2-7e | Tier-2 写工具（create/update_note、create_reminder、apply_update）+ draft/preview | 后端 | ✅ |
| P2-8 | AI 对话页面（聊天界面 + 草稿机制） | 前端 | 🚧 5/10 |
| P2-9 | 分屏拖拽（列表↔编辑、编辑↔预览） | 前端 | ⏳ |
| P2-10 | reminder_status 清理（90 天 fired 记录） | 后端 | ⏳ |

**P2 不做（延后事项）：**
- 远程连接（原 P2-1）— 与 P4 migration 同步机制耦合，整体留到 P4
- `open_note_in_gui`（daemon→GUI 反向通道）— 留到 P3 CLI 场景再做

**关键设计决策：**
- AI 草稿走 SSE 响应事件，GUI 自行打开 Tab（无反向通道）
- create_note 用 `draft_<uuid>` 占位 ID，首次 Cmd+S 走 POST
- update_note dirty 冲突弹 modal 三选一（接受 AI / 保留本地 / 查看差异）
- 待办页数据 = daemon 结果 + dirty tab overlay，订阅 editorStore 自动合并

### 实施阶段总览

```
P0 ✅ → P1 ✅ → P2 实施中（P2-0 ~ P2-4 ✅，P2-5 ~ P2-10 待开发） → P3（CLI+外部调用） → P4（Migration）
```

## 关键文件

- 完整计划：`docs/plans/COEDIT_PLAN.md`
- P1 设计文档：`docs/plans/2026-04-06-p1-design.md`
- Go 版问题清单：`docs/reference/ISSUES_FROM_GO.md`
- AI 搜索模式参考：`docs/reference/AI_SEARCH_PATTERNS.md`
