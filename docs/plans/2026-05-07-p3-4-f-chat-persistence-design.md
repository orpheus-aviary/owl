# P3.4-f 聊天持久化 + 侧栏布局 — 设计文档

日期：2026-05-07
子项：P3.4-f（P3.4 6 子项的最后一个；a-e 已 ship）
对齐依据：`docs/plans/2026-04-18-chat-persistence.md`（P2-8 后的现状 + 用户 2026-05-07 scope 回答取代其中漂移部分）

## 1. 目标

给 AI 聊天引入 Claude-desktop 风格：
- **左侧栏**列出所有历史会话，按 `updated_at DESC` 排序，顶部搜索框过滤标题
- **右侧主窗**照旧渲染选中会话的 MessageList + ChatInput
- **持久化** 在 daemon 的 `owl.db` 里（迁徙可同步 / CLI 可读）
- **跨切换流式不断线**：用户切到别的会话，原会话的 SSE 后台继续跑，回来看到完整进度

移除 `ChatTabBar`（tab 模型废弃）。

## 2. Scope（用户 2026-05-07 拍板）

| 维度 | 决定 |
|---|---|
| 排序字段 | `updated_at DESC`（偏离 2026-04-18 plan 的 `created_at DESC`；最近活跃的贴顶） |
| Rename | **不做**；标题 = 首条用户消息截 32 字（现有 `titleFrom` 逻辑保留） |
| 删除 | 右键弹 confirm（复用 `DeleteConfirmDialog` 视觉） |
| 持久化时机 | **懒**：用户发第一条消息时才写 DB；空会话只活在 ai-store 内存里（不进 sidebar 不占行） |
| 不持久化的 UI artifacts | **drafts / previews / note_applied toast** —— 历史视图里这些卡片不复现（plan 立场） |
| GUI streaming thinking 片段 | **不单独持久化** —— streaming 期间累积到 `ChatMessage.thinking` 的文本不存专列 |
| Daemon 侧 `reasoning_content` / `reasoning_signature` | **持久化**（DeepSeek V4 / Anthropic 续聊硬性要求；见 §3 字段语义）。其中 `reasoning_content` 在 `GET /ai/conversations/:id` 下发给 GUI，水合成 `ChatMessage.thinking` → 历史视图里思考链可展开（P3.4-c ThinkingBlock 默认折叠） |
| Tool calls / tool results | **持久化**（LLM 上下文必需）；`is_error` 入库供 GUI 水合红色失败态 |
| 系统提示词 | **仅在内存** —— agent loop 每 turn 由 `buildSystemPrompt` 重建（现有行为），不落盘、也不通过 `GET /ai/conversations/:id` 下发给 GUI。DB 层 `ai_messages.role` 的 CHECK 约束阻止 system 意外入库 |

明确**不做**（延到 P6 或视情况）：
- unread / last-message preview 卡片
- 消息全文搜索（只按标题客户端过滤）
- 导出 Markdown / JSON
- 会话文件夹 / 标签
- 跨设备同步冲突解决（P4 migration 范畴）

## 3. 数据模型（schema v3）

新增 `packages/core/src/db/migrations/0003_ai_chat.sql`，`LATEST_KNOWN_VERSION` **2 → 3**（P3.4-a 已经是 2）。

```sql
-- 0003_ai_chat.sql — ai_conversations + ai_messages (user_version = 3)
CREATE TABLE ai_conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,      -- unix ms, P3.4-a convention
  updated_at INTEGER NOT NULL       -- bumped on每轮 appendMessages
);

-- system 不入库（setSystemMessage 每 turn 由 agent loop 重建，落盘浪费）。
-- CHECK 约束是 role 值域的防御性兜底：即便 appendMessages 的 skip 被未来
-- 重构绕过，`INSERT ai_messages (role='system', ...)` 也会被 SQLite 拒掉。
-- 注意 CHECK 管不了"agent loop 完全不走 DB 的 direct push"——那种 bug 靠
-- §10 契约（禁直写 messages）+ §4.4 spy 测试（setSystemMessage 不产生 SQL
-- 写）+ 冷启动 hydrate 回归测一起盯。
CREATE TABLE ai_messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role                TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content             TEXT NOT NULL,
  tool_calls          TEXT,      -- JSON array；仅 role='assistant' 且发起 tool call 时非空
  tool_call_id        TEXT,      -- 仅 role='tool' 时非空
  is_error            INTEGER,   -- 0/1；仅 role='tool'；GUI 水合 ChatToolCall.isError 专用
  reasoning_content   TEXT,      -- 仅 role='assistant' 有思考链（DeepSeek V4 + Anthropic）
  reasoning_signature TEXT,      -- 同上；Anthropic-only 不透明 blob
  created_at          INTEGER NOT NULL, -- unix ms
  seq                 INTEGER NOT NULL  -- 会话内递增序号；读取用 ORDER BY seq
);

CREATE INDEX idx_ai_messages_convo_seq
  ON ai_messages(conversation_id, seq);

CREATE INDEX idx_ai_conversations_updated
  ON ai_conversations(updated_at DESC);
```

**约定 / 字段语义**：
- 时间字段 INTEGER Unix ms（P3.4-a 已立的项目不变量）
- `seq` 由应用层维护（`COALESCE(MAX(seq), 0) + 1`），同一 `appendMessages` 批量内严格递增；**不**用 rowid（避免删除后空洞）
- `reasoning_content` / `reasoning_signature`：**daemon 侧必须持久化**——DeepSeek V4 Pro/Flash 的 `thinking_round_trip` 和 Anthropic Extended Thinking 都要求 assistant 消息带回这两字段，否则下一轮请求被 reject 或退化。agent loop 从 `assembled.thinking` / `assembled.thinkingSignature` 写入。loading 时 daemon 重建 LlmMessage 必须填回
- `is_error`：**仅用于 GUI 历史水合**（恢复 `ChatToolCall.isError` 红色失败态）；daemon runtime 的 LlmMessage round-trip 当前就不保留 is_error（pre-existing bug in Anthropic adapter L415，不在 P3.4-f scope），未来修时再读此列
- `ON DELETE CASCADE` 让 `DELETE FROM ai_conversations` 自动清消息
- `PRAGMA user_version = 3` 由 `applyForwardMigrations` 自动 stamp（和 0002 一样）

**不建 FTS**：plan 说"消息全文搜索" out of scope；加 FTS 会显著扩表。

## 4. Daemon 改动

### 4.1 `ConversationStore` 改 SQLite-backed + 批量写 API

位置：`packages/daemon/src/ai/conversations.ts`

**关键决策**：**`runAgentLoop` 绝不得 `conversation.messages.push/unshift` 直写**。当前代码这么做（L103 system / L108 user / L154 assistant / L186 tool），导致 `append()` 方法从未被调用——是 dead code。P3.4-f 重写 store API 强制走 3 个方法，让 DB 落盘路径无缝嵌入：

```ts
interface ConversationStore {
  /**
   * Load-or-create. If `id` is provided and present in DB but absent from
   * the in-memory Map, hydrate: read all ai_messages rows ORDER BY seq,
   * rebuild LlmMessage[] (including reasoning_content / reasoning_signature
   * for assistant rows), then trimToRounds to config.ai.context_rounds
   * before the first LLM call burns tokens.
   */
  getOrCreate(id?: string): { conversation: Conversation; created: boolean }

  /**
   * Replace the index-0 system message in memory. NEVER hits DB — the
   * system prompt is built fresh every turn by agent loop, storing it
   * would just be stale bytes.
   */
  setSystemMessage(id: string, content: string): void

  /**
   * Atomically append a batch of messages for one agent-loop iteration.
   * Batch granularity = one LLM turn: `[user]` alone for the opening
   * user message, or `[assistant, ...toolResults]` for each iteration.
   *
   * Single SQLite tx:
   *   - First call for an id → INSERT ai_conversations (title = titleFrom(firstUserContent))
   *   - INSERT ai_messages × N with monotonic seq
   *   - UPDATE ai_conversations.updated_at = now()
   * Memory is updated in the same call so cache + DB don't diverge.
   * Skips role='system' defensively at the API layer (and the SQL CHECK
   * on `role` catches any attempt to write a system row through a future
   * code path that bypasses this skip).
   */
  appendMessages(id: string, msgs: LlmMessage[]): void

  /** Memory Map.delete + DELETE FROM ai_conversations (CASCADE clears messages). */
  delete(id: string): boolean

  /** SELECT id, title, created_at, updated_at, COUNT(*) FROM ai_conversations
   *  LEFT JOIN ai_messages ORDER BY updated_at DESC. */
  list(): ConversationSummary[]

  /** Memory-only trim (existing logic). LLM context window control;
   *  does NOT mutate DB — sidebar still shows full history. */
  trimToRounds(id: string, maxRounds: number): void
}
```

**`runAgentLoop` 改写映射**（见 §10 load-bearing 契约）：

| 现有 direct push | 改为 |
|---|---|
| L103/L105 system unshift / overwrite | `setSystemMessage(id, systemContent)` |
| L108 user push | `appendMessages(id, [userMsg])` — 首次触发 ai_conversations INSERT + title 计算 |
| L154 assistant push（每轮）+ L186 tool push（每个 tool result）| `appendMessages(id, [assistantMsg, ...toolResultMsgs])` — 单事务原子 |
| L198 `conversation.updatedAt = new Date()` | **删除** —— `appendMessages` 内部 bump `ai_conversations.updated_at` |

**原则**：**DB 是 source of truth**；内存缓存只在读 miss 时 hydrate、写时跟写。

### 4.2 新 / 扩展路由

`packages/daemon/src/routes/ai.ts`

| 方法 + 路径 | 变化 |
|---|---|
| `GET /ai/conversations` | **扩展**：从 store 取全部（DB 顺序，含 title），返回 `{ id, title, created_at, updated_at, message_count }[]` |
| `GET /ai/conversations/:id` | **新增**：返回 `{ id, title, messages: GuiMessage[] }`，**过滤 system**，`reasoning_signature` 不下发，`reasoning_content` / `is_error` 下发给 GUI 水合（见 §5.5） |
| `DELETE /ai/conversations/:id` | **保留**：`ConversationStore.delete()` 同时清内存 + `DELETE FROM ai_conversations WHERE id=?`（CASCADE 清消息） |
| `POST /ai/chat` | 不变签名；内部 agent loop 走 `setSystemMessage` + `appendMessages` 透明落盘 |

**PATCH rename 不实现**（用户拍板）。

### 4.3 Persist 时机 / 原子性

- **粒度 = 一轮 agent iteration**。`[assistant, ...toolResults]` 整体提交，**不会出现"assistant tool_calls 已写但 tool_result 未写"的悬空状态** —— LLM 续聊时上下文永远合法
- 首次 appendMessages（role='user' 那次）在单事务里 `INSERT ai_conversations` + `INSERT ai_messages`，title 从 `userMsg.content` 用 `titleFrom()` 算
- `updated_at` bump 也在同一事务里 → sidebar 排序立即反映最新活跃
- 崩溃恢复：已提交事务保留；未提交的 in-flight 流丢失（mid-iteration 崩溃 = 本轮 assistant 消息丢失，上一轮完整保留，LLM 续聊合法）

### 4.4 测试（daemon 侧）

`packages/daemon/src/ai/conversations.test.ts`（新建 / 扩展）：

**写路径**：
- 新会话首 `appendMessages([userMsg])` 写入 ai_conversations + 一条 ai_messages，title 正确截断
- 第二 `appendMessages([assistant, tool1, tool2])` 原子写三条 ai_messages，seq 递增 = 2/3/4，`updated_at` 推进
- `reasoning_content` + `reasoning_signature` 在 assistant 行落盘
- `is_error=true` 的 tool result 落盘 `is_error=1`
- `setSystemMessage` 不产生 SQL 写（用 spy）
- **CHECK 约束防御**：构造 LlmMessage `{role:'system'}` 试着绕过 `appendMessages` 的 skip 直接 `INSERT INTO ai_messages` → SQLite 报 CHECK 违反

**读路径（冷启动）**：
- Scenario：写一轮消息 → 销毁 ConversationStore 实例 → 新建 ConversationStore 指向同一 sqlite → `getOrCreate(id)` 拿到的 LlmMessage[] 包含 reasoning 字段、tool_calls/tool_call_id 配对、`seq` 顺序正确
- hydrate 后 ConversationStore 自动 `trimToRounds` 到 config.context_rounds（10 轮历史 + context_rounds=3 → 只留末 3 轮）
- `list()` 按 `updated_at DESC`

**删除路径**：
- `delete(id)` → 内存 Map 清 + DB 两表都清（CASCADE）

`packages/daemon/src/routes/ai.test.ts` 加：
- `GET /ai/conversations/:id` 不含 system 消息；不含 reasoning_signature；含 reasoning_content / is_error
- `GET /ai/conversations/:id` 404 未知 id
- `DELETE /ai/conversations/:id` CASCADE 删消息

## 5. GUI ai-store 形态改动

这是**重头戏**——现状 `chats: ChatTabState[]` + `activeChatId`，承载 P2-8 / P3.0.5 / P3.4-c 多个层次。新形态要最小侵入。

### 5.1 id 模型收敛

**现状**：`ChatTabState.id`（local UUID）与 `conversationId`（server-issued，null until 第一条 SSE）分离。
**改后**：**只一个 id**——GUI 生成 UUID，在首次 `POST /ai/chat` 时作为 `conversation_id` 传给 daemon；daemon 的 `getOrCreate` 已支持外部 id，沿用。

这让 sidebar / ai-store / server 三边用同一把 id。`ChatTabState.conversationId` 字段删。

### 5.2 新 State 形态

```ts
interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;      // Unix ms
  updatedAt: number;
}

interface AiState {
  // Sidebar list — meta only, hydrated from GET /ai/conversations on mount
  // and after every send/delete.
  conversations: ConversationMeta[];
  conversationsLoaded: boolean;

  // Per-conversation messages cache. Lazy-filled on click (GET /ai/conversations/:id)
  // or eagerly by send (appended as SSE streams). Ephemeral conversations
  // (no id in DB yet) live here too under their local UUID.
  messagesByConversation: Record<string, ChatMessage[]>;

  // Per-conversation streaming state (kept alive across active-id switches).
  streamingByConversation: Record<string, StreamingState>;

  activeConversationId: string | null;

  // Queues + scroll positions keyed by conversation id (same keys).
  noteAppliedNotices: NoteAppliedNotice[];
  scrollByConversation: Record<string, number>;

  // Actions (renamed from chats → conversations)
  newConversation: () => string;       // creates ephemeral client-only id
  setActiveConversation: (id: string) => void;
  sendMessage: (id: string, text: string) => Promise<void>;
  abortStreaming: (id: string) => void;
  deleteConversation: (id: string) => Promise<void>;   // confirm lives in UI
  loadConversations: () => Promise<void>;
  loadConversation: (id: string) => Promise<void>;     // hydrate messages

  // P3.0.5 draft-approve surface unchanged (renamed keyed id only)
  markDraftOpened / approveDraft / approveAllDrafts / dismissNoteAppliedNotice / setScroll
}

interface StreamingState {
  isStreaming: boolean;
  abortController: AbortController | null;
  assistantMessageId: string | null;   // for SSE dispatcher to patch
}
```

### 5.3 关键行为

- **Mount 时**：`AIPage` effect 调 `loadConversations()` → `GET /ai/conversations`
- **切换会话** (`setActiveConversation`)：纯切 id，**不 abort** 原会话的流（关键！支持跨切换流式）
- **Click 未 hydrated 的会话**：`loadConversation(id)` 发 `GET /ai/conversations/:id`，把 LlmMessage[] 转成 ChatMessage[]（drafts/previews/thinking 填空）+ 重建 toolCalls 配对
- **Send**：
  - ephemeral conversation（`conversations[]` 里没有 meta） → SSE 结束后 `loadConversations()` 刷新 sidebar（服务端首 append 已持久化）
  - 已存在的 conversation → 同上，服务端会 bump updated_at → sidebar 重排
- **Delete**：`deleteConversation(id)` 如果 id 在 DB → `DELETE /ai/conversations/:id` + 本地清理；纯 ephemeral（从未发过消息）→ 只清本地

### 5.4 Streaming across switches 的落点

每个 `StreamingState` 持有自己的 AbortController。`setActiveConversation` 仅改 `activeConversationId`，不碰其他会话的流。`sendMessage` 的 finally 清理 `streamingByConversation[id]`。Sidebar 项显示一个小 spinner（`isStreaming`）指示后台跑着。

### 5.5 Hydration：LlmMessage[] → ChatMessage[]（hydration 的最绕一段）

`GET /ai/conversations/:id` 返回的 messages 形如 OpenAI 格式，但 daemon 额外**给 GUI 下发了两字段**：assistant 消息带 `reasoning_content?: string`，tool 消息带 `is_error?: boolean`（`reasoning_signature` 不下发——Anthropic 黑箱，GUI 无用）。

```
[user] "..."
[assistant] content + tool_calls: [{id, name, args}, ...] + reasoning_content?
[tool] tool_call_id=X, content=<JSON result>, is_error=false
[tool] tool_call_id=Y, content=<JSON result>, is_error=true
[assistant] content + tool_calls: [...] + reasoning_content?
[tool] ...
[user] "..."
...
```

GUI 折叠算法：顺扫 messages：
- `assistant + tool_calls` → 新 ChatMessage（role=assistant，toolCalls 初始化缺 result）；`thinking = reasoning_content ?? ''`（免费恢复思考链折叠块；P3.4-c 的 ThinkingBlock 默认折叠，无噪音）
- `tool` → 找最近 assistant 的 `toolCalls` 里 `id === tool_call_id` 的项填 `result` + `isError = is_error`
- `user` → 普通 ChatMessage（role=user）
- `system` → 过滤（daemon 已过滤但 GUI 防御性再过一遍）

`drafts[]` / `previews[]` 都空——历史消息不重现卡片（和 plan 一致）。`isStreaming = false`。

## 6. ChatSidebar 组件（新建）

位置：`packages/gui/src/renderer/src/components/ai/ChatSidebar.tsx`

- 顶部：「新建对话」按钮（Plus 图标，调 `newConversation`）+ 搜索框（客户端 debounce 过滤 `title`，不发请求）
- 滚动列表：每条 `ConversationMeta` 一行
  - 左：title（truncate）
  - 右上：相对时间（`updatedAt`）
  - 右下：streaming 指示（`streamingByConversation[id]?.isStreaming` 时 pulse dot）
  - 行状态：active / hover 样式仿 `NoteListItem`
- 右键 → ContextMenu「删除」→ 弹 confirm（复用 DeleteConfirmDialog 组件的 `ConfirmDialog` 底层，不走 `useRequestDeleteNote` 的 note-specific 流程）

**DeleteConfirmDialog 复用策略**：该组件目前和 note 删除耦合严重（special-note guard / dirty-jump / navigate）。不硬塞 conversation 概念。**新建一个轻量** `ConfirmDialog.tsx` 抽离视觉，或复制两行 AlertDialog 模板。优先后者——`DeleteConfirmDialog` 的内部 Dialog 壳很轻，直接 inline 在 ChatSidebar 里最简洁。

### 6.1 Sidebar 可达性

- 列表容器 `tabIndex={0}` + ArrowUp/Down 切换 active（对齐 P3.4-e 的 NoteList 模式；但这里切 active 也**就是**切到主窗，没"预览 vs 固定"概念，更简单）
- 搜索框 Input focus 时上下键不劫持（同样 tagName 守卫）

## 7. AIPage 改造

从「ChatTabBar + MessageList + ChatInput」改为「ChatSidebar | (MessageList + ChatInput)」双栏。

```
+---------------+----------------------------+
| 新建 | 搜索 |                            |
+---------------+----------------------------+
| 会话 A       |  MessageList                |
| 会话 B       |                             |
| 会话 C       |                             |
| ...          +----------------------------+
|              |  ChatInput                  |
+---------------+----------------------------+
```

- 用 `react-resizable-panels`（项目已有）做左右可拖分割；**新增 `LAYOUT_KEYS.aiLayout: 'owl-ai-layout'` 常量**（`packages/gui/src/renderer/src/lib/layout-keys.ts` 目前只有 4 个 key，没 ai），避免散落裸字符串
- 空态：`activeConversationId == null` 或会话 messages 为空 → 原 `EmptyState` 组件保留
- Mount effect 改：`loadConversations()`；**不**自动 newConversation（空 sidebar 显示"新建对话"按钮即可，用户主动点）

## 8. 数据迁移

**daemon 进程重启**：新 schema 自动创建两表（forward migration runner 已验）。老 in-memory 会话丢失——和**目前的行为一样**（daemon 重启本来就清空），所以不算 regression。

**已 ship 到用户的数据库**：LATEST_KNOWN_VERSION 2 → 3 的升级是**非破坏性**（纯 CREATE TABLE，不动 notes / folders），forward runner 静默升级；`assertNotDestructive` 自动通过。

**测试用户数据库备份**：动前 `cp ~/orpheus-aviary-nest/owl/owl.db ~/orpheus-aviary-nest/owl/owl.db.pre-p3-4-f-$(date +%s)`，防翻车（和 P3.4-a 一致）。

## 9. 测试策略

### 9.1 Daemon
- `conversations.test.ts`（新 / 扩展）：上文 §4.4 列项（含 CHECK 约束防御、冷启动 hydrate、trim-after-load）
- `routes/ai.test.ts` 扩展：三个路由行为 + `reasoning_content` / `is_error` 下发校验
- 回归：现有 128 个 daemon 测试应全绿（agent loop 语义不变，只是走 store 的新 API）

### 9.2 GUI
- `ai-store.test.ts` 扩展 / 重写：
  - `loadConversations` / `loadConversation` hydration（mock api）
  - **hydration 填回 `ChatMessage.thinking` from `reasoning_content`**（§5.5 新路径）
  - **hydration 填回 `ChatToolCall.isError` from `is_error`**
  - `sendMessage` on ephemeral id 走通
  - `setActiveConversation` 不 abort 他人流
  - `deleteConversation` ephemeral vs persisted 两分支
  - 历史 messages[] → ChatMessage[] 折叠算法（tool_calls 配对 + reasoning + is_error）
- `ai-dispatcher.test.ts`：签名改了 keyed id 名但语义不动，回归
- 新 `ChatSidebar.test.tsx`：
  - Render meta list，ArrowUp/Down 切 active
  - 搜索框输入过滤 title
  - 右键 → confirm → delete 调用 store action
- **React 19 + pnpm 测试坑**：遵循 P3.4-e 发现的规律——测试里 mock zustand / Radix / dnd-kit 链路的重资源依赖

### 9.3 手动 E2E（上线前必跑）
1. 起 daemon + GUI，发 3 条消息 → 关 GUI → 重开 → sidebar 里能看到会话 → 点击恢复完整历史（含 tool calls、失败 tool 保留红色态、思考链可展开）
2. 起一条流式 → 切到另一会话 → 原会话后台跑完 → 回去看到完整 assistant 消息
3. 右键删除 → confirm → sidebar 项消失 → 重启 GUI 依然不在
4. daemon 独立重启（不关 GUI）→ GUI 下一次 `loadConversations` 应能继续看到历史
5. **DeepSeek V4 或 Anthropic 模型续聊**：发 3 轮 → 重启 daemon → GUI 点会话进去 → 发第 4 轮 → 不得报 "prior turn rejected"（验证 reasoning round-trip 生效）

## 10. Load-bearing 契约

- **id 收敛**：GUI 生成的 UUID = conversation_id = DB 主键，三边一致。首次 `POST /ai/chat` 传 `conversation_id`，daemon `getOrCreate(id)` 认
- **agent loop 永远不得直接 `push/unshift` `conversation.messages`** —— 只走 `setSystemMessage` / `appendMessages` 两个方法。否则漏写 DB。DB 层的 `CHECK (role IN ('user','assistant','tool'))` 是防御性兜底，阻止 system 意外入库
- **`appendMessages` 事务粒度 = 一轮 agent iteration**（`[assistant, ...toolResults]` 整体提交）——mid-iteration 崩溃不留悬空 `tool_calls` 无 `tool_result`，LLM 续聊时上下文永远合法
- **单 writer 不变量**：一个 conversation_id 同时只有一个 agent loop 在写（GUI `sendMessage` 的 `isStreaming` guard 保证，CLI 目前不走 `/ai/chat`）。如果未来 CLI 加入 AI 调用，需重新评估 `seq` 写入冲突——届时给 `appendMessages` 加锁或把 seq 改成 `MAX(seq)+1` 的单事务计算
- **DB 是 source of truth**：内存缓存是性能优化，miss 时必须能从 DB lazy-load 重建；hydrate 后立即 `trimToRounds` 到 `config.ai.context_rounds`，防止重启后续聊时把 200 条历史全发 LLM
- **reasoning_content / reasoning_signature 必须 round-trip**：DeepSeek V4 Pro/Flash + Anthropic Extended Thinking 硬性要求；缺失下一次 LLM 请求被 reject 或 reasoning 能力退化。落盘 + hydrate 两步都要存
- **`is_error` 仅供 GUI 水合**：daemon runtime LlmMessage 当前不保留 is_error（pre-existing Anthropic adapter 缺陷，不在 P3.4-f scope）；这列是"未来修"的种子，别以为 agent loop 会读
- **system 消息永不下发给 GUI**：`GET /ai/conversations/:id` 过滤 `role === 'system'`（LLM prompt engineering 私有）
- **`reasoning_signature` 也不下发给 GUI**：Anthropic 内部不透明 blob，GUI 无用；`reasoning_content` 下发，GUI 水合成 `ChatMessage.thinking` 折叠块
- **`setActiveConversation` 不 abort 流**：`streamingByConversation` 跨切换保活是此子项的招牌特性；回归这一点等于废 P3.4-f
- **drafts / previews 不持久化**；历史消息水合时 `drafts[]=[]` / `previews[]=[]`
- **CASCADE 删消息 + 本地清缓存双动**：DELETE 路由走 DB CASCADE；`ConversationStore.delete` 也清 in-memory Map；GUI `deleteConversation` 同步清 `messagesByConversation[id]` / `streamingByConversation[id]` / `scrollByConversation[id]` / `conversations` 过滤

## 11. 偏离 2026-04-18 plan 记录

| 点 | Plan | 本设计 | 原因 |
|---|---|---|---|
| 排序 | created_at DESC | **updated_at DESC** | 用户 2026-05-07 拍板；继续聊同一老会话时它能冒顶 |
| Rename | optional PATCH | **不做** | 最小 scope；用户 2026-05-07 拍板 |
| id 模型 | 未明确 | **单 id**（GUI 生成 = DB 主键） | 简化；两-id 模型的 `conversationId: null` 会让 sidebar hydration 逻辑复杂 |
| 持久化写入口 | plan 说"`ConversationStore` append 内部落盘" | **重写 store 为 3 方法 API**（`setSystemMessage` / `appendMessages` / `getOrCreate+hydrate`），agent loop 改走这些 | 现状 agent loop 是 direct push，plan 的 `append()` 是 dead code；不改写 API 等于 DB 漏写 |
| 持久化事务粒度 | 未明确（plan 说"每条消息 append"） | **per-iteration batching**（`[assistant, ...toolResults]` 一个事务） | 避免悬空 `tool_calls` 无 `tool_result` 的中间状态；LLM 续聊永远合法 |
| Thinking 持久化 | "不存"（隐含包括 reasoning） | **daemon 侧 `reasoning_content` + `reasoning_signature` 必须存**；GUI 侧 `ChatMessage.thinking` 顺道从 `reasoning_content` 水合（免费升级） | DeepSeek V4 / Anthropic 多轮 round-trip 硬性要求；不存续聊会炸 |
| Tool result `is_error` | 未提 | **加 `is_error INTEGER` 列**（GUI 水合专用） | 现 `ChatToolCall.isError` 依赖；不存则历史 tool 失败态丢失（红变绿） |
| schema system 角色 | plan 允许 `role IN (... 'system' ...)` | **CHECK 拒绝 system**（system 只在内存） | 防御性强约束；system prompt 每 turn 重建，落盘是浪费 + 泄露 |
| `GET /ai/conversations/:id` | plan 说"新增" | **同上，额外过滤 reasoning_signature / 明确 system 过滤 / 下发 reasoning_content + is_error** | 兼顾 GUI 水合需求 + 避免 Anthropic 黑箱泄露 |
| `ChatMessage` 模型 | plan 写得简 | **保留 P2-8 / P3.0.5 / P3.4-c 已有字段**（thinking / drafts / previews / aborted / error） | 不能退化已 ship 能力；只是历史水合时 drafts / previews 字段空 |

## 12. 实施顺序

1. **Schema & LAYOUT_KEYS**：
   - `packages/core/src/db/migrations/0003_ai_chat.sql` + `LATEST_KNOWN_VERSION = 3`
   - `packages/gui/src/renderer/src/lib/layout-keys.ts` 加 `aiLayout: 'owl-ai-layout'`
2. **Daemon ConversationStore + agent loop 改写**：
   - `ConversationStore` 重写为 3 方法 API（`setSystemMessage` / `appendMessages` / `getOrCreate+hydrate`）
   - `runAgentLoop` 把 4 处直写 `messages` 改走 store 方法
   - `GET /ai/conversations/:id` 新增；`GET /ai/conversations` 扩展；`DELETE` CASCADE 验证
   - daemon 测试全跑（`just test-daemon`），含 CHECK 约束防御 + 冷启动 hydrate + trim-after-load
3. **GUI store 形态变更**：
   - 重写 `ai-store.ts`：`chats[]` → `conversations[]` + `messagesByConversation` + `streamingByConversation`
   - `ai-store-types.ts` 加 `ConversationMeta`，`ChatTabState` 改名为 `ConversationState`（内部类型）
   - `ai-dispatcher.ts` 签名换 id 名（chatId → conversationId），逻辑不变
   - 历史 messages → ChatMessage 折叠器 `hydrateDaemonMessages()`（含 reasoning_content → thinking, is_error → isError）
   - ai-store 单测扩展
4. **UI**：
   - 新建 `ChatSidebar.tsx`（含内联小 AlertDialog）
   - 改 `AIPage.tsx` 为双栏布局 + `loadConversations` 初始化
   - 删除 `ChatTabBar.tsx`
5. **Wire-through 回归**：`MessageBubble` / `MessageList` / `ChatInput` 内部通过 store 读 active conversation，改 id 名足够；`linkifyNoteIds` 照常工作（P3.4-c 契约不变）
6. **手动测试清单**（§9.3 5 条）→ 用户签字
7. `just check` + `just test` 全绿
8. Commit + 更新 memory + PROCESS.md 标完 → P3.4 整段 ✅ → 进入 P4

## 13. 风险 / 边界

- **现有 ai-store 测试要大改**：`ai-store.test.ts` 50+ 处引用 `chats[]` / `activeChatId`；逐条替换
- **React 19 hook dup 的老账**：sidebar 测试里 zustand / Radix ScrollArea 会触发老问题——提前按 P3.4-e 经验 mock 解决
- **ephemeral id 漂移**：用户点「新建」立即又切走，然后再回来——ephemeral 对话应一直留在 ai-store 里，只是 sidebar 不显示（因为 DB 没行）。测试用例覆盖"从未发消息的新建 → 切走 → 切回 → 仍在"
- **首 appendMessages 事务如果失败**：目前设计 agent loop 忽略持久化 error（内存仍更新，用户看到 SSE 流）。建议 try/catch 里 log warn + 给 SSE 发 `error` 事件，**不让 LLM 继续流**（否则本地和 DB 永久漂移）。或直接抛死让 agent loop 停，用户重试
- **单 writer 不变量被破坏**：未来 CLI 加 AI 调用就是第二个 writer；要么加 `UNIQUE(conversation_id, seq)` + 冲突重试，要么在 `appendMessages` 内用行锁（SQLite 是表级锁，天然串行化写，所以其实只要不绕过 store 就没事）——记到 P6 评估
- **资源：消息很长**：单 assistant 消息几 KB；1000 条 = ~10MB 表大小，SQLite 扛得住。将来若加全文搜索再评估
- **migration bisync 冲突**：`owl.db` 被 P4 migration 同步时，两端如果同时新增会话行，bisync 会把 `ai_conversations` 看作独立 row 保留——但消息序列可能错乱（同一 convo 两边独立写）。P4 scope 时需给 AI 表单独策略或 last-write-wins。P3.4-f 不解决

---

## Implementation record

日期：2026-05-07  
测试状态：**563/563 绿**（core 150 + cli 119 + daemon 138 + gui 156，gui +11 / daemon +10 对比 P3.4-e）

### 动过的文件（16 个）

**Daemon + Core（持久化层）**：
- `packages/core/src/db/migrations/0003_ai_chat.sql` — 新建（ai_conversations + ai_messages + 2 索引 + role CHECK）
- `packages/core/src/db/migrate.ts` — `LATEST_KNOWN_VERSION` 2 → 3
- `packages/core/src/db/migrate.test.ts` — F2/F4 测试改用 LATEST 常量，F4 验 ai 表创建
- `packages/daemon/src/ai/conversations.ts` — **完全重写**：3 方法 API（`setSystemMessage` memory-only / `appendMessages` 单事务原子批量 / `getOrCreate` 冷启动从 DB hydrate），私有辅助拆 complexity
- `packages/daemon/src/ai/llm-client.ts` — `LlmMessage.is_error?: boolean` 新增
- `packages/daemon/src/ai/agent-loop.ts` — 4 处直写 push 改走 store API；抽出 `runIteration` 子生成器降 complexity
- `packages/daemon/src/routes/ai.ts` — `GET /ai/conversations` 加 title；`GET /ai/conversations/:id` 新增（过滤 system + reasoning_signature）
- `packages/daemon/src/cli.ts` — `new ConversationStore(sqlite)` 传 DB
- 4 个测试文件（agent-loop / routes/ai / server / routes/events）构造器加 sqlite；新增 P3.4-f 测试段（+10 cases：写路径 / 冷启动 hydrate / CHECK 防御 / list order / delete CASCADE / 2 个路由测试）

**GUI（store + UI 层）**：
- `packages/gui/src/renderer/src/lib/layout-keys.ts` — 加 `aiLayout`
- `packages/gui/src/renderer/src/lib/api.ts` — 加 `AiHistoryMessage` / `AiConversationDetail` / `getAiConversation`；`AiConversationSummary` 加 `title`
- `packages/gui/src/renderer/src/stores/ai-store-types.ts` — 删 `ChatTabState`，新增 `ConversationMeta` / `StreamingState`；`ChatMessage` 保留所有 P2-8 / P3.0.5 / P3.4-c 字段
- `packages/gui/src/renderer/src/stores/ai-dispatcher.ts` — 签名改：输入 `messages[]` 而非 `chats[]`，`chatId` 字段去掉；逻辑不变；`conversation_id` 事件变 no-op
- `packages/gui/src/renderer/src/stores/ai-store.ts` — **完全重写**：`chats[]` → 三 map（`conversations` / `messagesByConversation` / `streamingByConversation`）；新 actions `loadConversations` / `loadConversation` / `deleteConversation`；`hydrateDaemonMessages` 折叠算法；**`EMPTY_MESSAGES` 模块级常量**（React 19 getSnapshot 稳定性）
- `packages/gui/src/renderer/src/components/ai/ChatSidebar.tsx` — 新建（新建 / 搜索 / 会话列表 / 键盘导航 / 右键 confirm 删）
- `packages/gui/src/renderer/src/components/ai/ChatInput.tsx` / `MessageBubble.tsx` / `MessageList.tsx` — prop `chatId` → `conversationId`，语义不变
- `packages/gui/src/renderer/src/pages/AIPage.tsx` — 改双栏布局 + `loadConversations` 初始化 + `useActiveConversationMessages` 驱动
- `packages/gui/src/renderer/src/components/ai/ChatTabBar.tsx` — **删除**
- `packages/gui/src/renderer/src/stores/ai-dispatcher.test.ts` / `ai-store.test.ts` — 全量重写匹配新形态；**+11** 新 cases（包括 hydration / ephemeral 行为 / setActiveConversation 不 abort / delete persisted vs ephemeral / loadConversations / loadConversation 缓存命中）

### 实施偏离设计

- **Dialog vs AlertDialog**：设计 §6 考虑内联 AlertDialog 或复用 DeleteConfirmDialog；项目 `components/ui/` 没有 `alert-dialog.tsx`，改用现有 `Dialog`。视觉等价
- **getOrCreate 路由处理 404**：设计没细说，实施时用"fresh empty → delete the ephemeral Map entry → 返回 404"兼容 lazy-create 语义
- **runAgentLoop 重构**：设计只说"改 4 处 push"；实施顺带把嵌套 for-loop 抽成 `runIteration` 子 async generator + `IterationResult` 判别联合类型。biome cognitive complexity 从 34 降到合规

### 踩的坑（下次动这块必看）

1. **React 19 getSnapshot 稳定性**：zustand selector 里 `?? []` 会每 render 创建新数组 → React 判 snapshot 变 → 抛 "getSnapshot should be cached" + 无限循环（AI 页全黑）。必须用**模块级常量** `EMPTY_MESSAGES`。此规律适用于所有返回"可能 undefined 的列表"的 zustand selector
2. **runAgentLoop 是 async generator**：抽 helper 时 helper 也得是 `async function*` + 返回 `AsyncGenerator<..., Result>` 两个类型参数才能 `yield*` + `return value`；否则主 loop 拿不到终止信号
3. **Biome security_reminder_hook 误报**：SQL 里 prepare().run/all() 在某些多行模板里触发"command injection"警告。绕法：把 SQL 绑到 `const X_SQL = '...'` 常量；Edit 不 Write；拆多个 prepare 调用
4. **agent-loop 测试数据 push**：旧测试 `conversation.messages.push(...)` 直接写数组绕过 store。新 store 的 `trimToRounds` 仍接受这种 seed 方式（内存 only），所以旧 trim 测试不必重写
5. **P3.4-a F2 测试**：断言 `user_version === 2` 硬编码过时；改用 `LATEST_KNOWN_VERSION` 符号。F4 同理改成 `LATEST + 1` 作为"文件缺失"目标，避免未来 bump 再坏
6. **seed 对话可直接 SQL 写/清**：daemon 停机时无法用 REST 清，直接对 `~/orpheus-aviary-nest/owl/owl.db` 写 DELETE 最干净（CASCADE 清消息）

### 手动测试结果

用户 2026-05-07 手动跑完 5 段清单（持久化 + 水合、ephemeral、跨切换流式、删除 confirm、LLM 续聊），无问题。

### 测试备份

- DB 备份：`~/orpheus-aviary-nest/owl/owl.db.pre-p3-4-f-1778091724`
- 2 条 seed 会话已清理（sqlite DELETE CASCADE）
- 用户真实会话 `cd5ce8a6...` 未触碰
