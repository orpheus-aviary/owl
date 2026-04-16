# P2-7 AI Tool Registry + Daemon Agent Loop — Implementation Plan

## Context

P2-7 adds AI capabilities to the owl-ts daemon. The daemon hosts an agent loop that receives user messages via SSE, calls LLM with tool-use, executes tools against the note database, and streams results back. This is the backend foundation — the GUI chat page (P2-8) builds on top.

Split into 5 sub-phases: P2-7a → 7b → 7c → 7d → 7e, each independently testable.

## Design Decisions (agreed 2026-04-16)

- **Search**: 2-layer — Layer 1 recent fill (by updated_at, up to max_context_chars) + Layer 2 LLM-driven FTS5 search. Embedding deferred to P3.
- **LLM Client**: `@anthropic-ai/sdk` + `openai` SDK, NOT raw fetch.
- **search_notes**: Keep `max_chars` parameter (renamed from token_budget) to control cumulative returned content length.
- **Conversations**: In-memory only, cleared on daemon restart.
- **Draft mechanism**: No tab → open; Tab clean → modify; Tab dirty → conflict dialog.
- **Config addition**: `max_context_chars: number` (default 30000) added to `[ai]` section.

## File Structure

```
packages/daemon/src/ai/
├── llm-client.ts          # P2-7a: OpenAI/Anthropic SDK adapter
├── tool-registry.ts       # P2-7b: Tool interface + registry
├── tools/                 # P2-7b/7e: Individual tool implementations
│   ├── search-notes.ts
│   ├── get-note.ts
│   ├── list-tags.ts
│   ├── list-folders.ts
│   ├── get-reminders.ts
│   ├── get-todos.ts
│   ├── get-capabilities.ts
│   ├── append-memo.ts
│   ├── add-todo.ts
│   ├── create-reminder.ts
│   ├── create-note.ts     # P2-7e
│   ├── update-note.ts     # P2-7e
│   └── apply-update.ts    # P2-7e
├── agent-loop.ts          # P2-7c: Message → LLM → tool → loop
├── conversations.ts       # P2-7c: In-memory conversation store
├── system-prompt.ts       # P2-7c: System prompt + Layer 1 recent fill
├── preview-store.ts       # P2-7e: External agent preview storage
└── sse.ts                 # P2-7d: SSE helper (initSse/sendSseEvent/endSse)

packages/daemon/src/routes/
└── ai.ts                  # P2-7d: POST /ai/chat + conversation routes
```

---

## P2-7a: LLM Client Abstraction

**Goal:** Unified streaming interface over OpenAI + Anthropic SDKs.

**Install:** `pnpm add @anthropic-ai/sdk openai` in packages/daemon

**Create:** `packages/daemon/src/ai/llm-client.ts`

**Key interfaces:**

```ts
interface LlmToolDef { name: string; description: string; parameters: Record<string, unknown> }

interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | LlmContentBlock[]
  tool_call_id?: string
  tool_calls?: LlmToolCall[]
}

interface LlmToolCall { id: string; name: string; arguments: string }

type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'done'; stop_reason: string }

interface LlmClient {
  chatCompletion(
    messages: LlmMessage[],
    tools: LlmToolDef[],
    options?: { max_tokens?: number; temperature?: number },
  ): AsyncIterable<StreamChunk>
}

function createLlmClient(config: LlmConfig): LlmClient
```

**Implementation:**
- `createLlmClient` dispatches to `OpenAiAdapter` or `AnthropicAdapter` based on `config.api_format`
- OpenAI adapter: `new OpenAI({ baseURL, apiKey })` → `chat.completions.create({ stream: true })`
- Anthropic adapter: `new Anthropic({ baseURL, apiKey })` → `messages.stream()`
- System message: OpenAI → `role: 'system'`; Anthropic → `system` parameter
- Tool def translation: OpenAI `{ type: 'function', function: {...} }`; Anthropic `{ name, description, input_schema }`
- Throws if url/model/api_key empty
- Create per-request (not at startup) so config changes take effect immediately

**Existing code to reuse:**
- `resolveLlmConfig(config)` from `@owl/core` (packages/core/src/config/index.ts)
- Leave existing `pingLlm` in routes/config.ts as-is

**Gotchas:**
- URL normalization: strip trailing `/v1`, `/` for Anthropic SDK; OpenAI SDK expects baseURL ending at `/v1`
- Both SDKs must work with daemon's `"type": "module"` ESM setup

**Verify:** `just check` passes, manual test with real LLM credentials

---

## P2-7b: Tool Registry + Read/Specialized Tools

**Goal:** Registry of 10 tools (7 read + 3 specialized) callable standalone.

**Create:** `tool-registry.ts` + 10 files under `tools/`

**Key interfaces:**

```ts
interface ToolContext {
  db: OwlDatabase; sqlite: Database.Database; config: OwlConfig
  deviceId: string; scheduler: ReminderScheduler; source: 'gui' | 'external'
}

interface ToolDef {
  name: string; description: string
  parameters: Record<string, unknown>  // JSON Schema
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>
}

class ToolRegistry {
  register(tool: ToolDef): void
  get(name: string): ToolDef | undefined
  all(): ToolDef[]
  toLlmToolDefs(): LlmToolDef[]
}
```

**Tool implementations (each wraps existing core functions):**

| Tool | Core function | Notes |
|------|--------------|-------|
| `search_notes` | `searchNotesWithDetails` + `listNotes` | `max_chars` param truncates cumulative content. Empty query → recent by updated_at |
| `get_note` | `getNote(db, id)` | Full note + tags |
| `list_tags` | SQL from routes/tags.ts | search + limit params |
| `list_folders` | `listFolders(db)` | Flat list with parent_id |
| `get_reminders` | SQL from routes/tags.ts | from/to/status filter |
| `get_todos` | Inline todo regex parser | Copy regex from routes/todos.ts (sync note in comment) |
| `get_capabilities` | `registry.all()` | Return tool names + descriptions |
| `append_memo` | `getNote` + `updateNote` | Append to SPECIAL_NOTES.MEMO |
| `add_todo` | `getNote` + `updateNote` | Append `- [ ] content` to SPECIAL_NOTES.TODO |
| `create_reminder` | `createNote` + parseTags | Create with `/alarm` tag, call `scheduler.onNoteChanged` |

**search_notes detail:**
- FTS search via `searchNotesWithDetails(db, sqlite, query, limit)`
- Accumulate results sorted by rank/recency, stop when cumulative chars > `max_chars`
- Long notes get truncated (first 200 chars + "...")
- Supports optional `tags`, `folder_id`, `include_descendants` filters
- Empty query → `listNotes` by updated_at desc (recent notes fallback)

**JSON Schema for parameters:** Use literal objects (not Zod), valid JSON Schema draft-07.

**Verify:** Unit tests for each tool (in-memory DB pattern from server.test.ts). `just test` + `just check`

---

## P2-7c: Agent Loop + Conversations

**Goal:** Core loop orchestrating LLM → tool execution → response.

**Create:** `agent-loop.ts`, `conversations.ts`, `system-prompt.ts`

**Agent events:**

```ts
type AgentEvent =
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: unknown }
  | { type: 'draft_ready'; action: string; note_id: string; content: string; tags: string[]; folder_id: string | null; original_content?: string; original_tags?: string[] }
  | { type: 'preview_ready'; preview_id: string; action: string; diff: string; content: string; tags: string[] }
  | { type: 'message'; content: string }
  | { type: 'error'; message: string }
  | { type: 'done'; conversation_id: string }

async function* runAgentLoop(options, toolRegistry, llmClient, conversations, toolCtx, config): AsyncGenerator<AgentEvent>
```

**Agent loop flow:**

```
1. conversations.getOrCreate(conversationId)
2. Build system prompt (persona + date/time + Layer 1 recent notes)
3. Append user message, trim to context_rounds
4. Loop (max 10 iterations, 120s timeout):
   a. llmClient.chatCompletion(messages, toolDefs)
   b. Reassemble stream chunks → text + tool calls
   c. Text → yield { type: 'message' }
   d. Tool calls → yield tool_call, execute, yield tool_result
      - If result has sideEffect → yield draft_ready/preview_ready (P2-7e)
      - Append messages, continue loop
   e. No tool calls → break
5. yield { type: 'done' }
```

**System prompt (Layer 1 — recent fill):**
- `listNotes(db, sqlite, { sortBy: 'updated', sortOrder: 'desc', limit: max_recent_notes })`
- Accumulate content up to `max_context_chars` threshold
- Include note ID, title, tags, content so LLM has immediate context
- LLM calls `search_notes` tool (Layer 2) when it needs more

**Conversation store:**
- `Map<string, { messages, createdAt }>` in memory
- `trimToRounds(id, maxRounds)`: keep last N user↔assistant pairs, preserve tool call/result groups
- `getOrCreate`: generates UUID if no ID provided

**Config addition to core:**
- Add `max_context_chars: number` (default 30000) to `AiConfig` in `packages/core/src/config/index.ts`

**Gotchas:**
- Handle parallel tool calls (multiple tool_calls in one LLM response)
- Tool errors → return error string as tool result, don't crash loop
- Stream reassembly: accumulate tool_call_delta arguments until tool_call_end
- trimToRounds must not orphan tool results from their tool calls

**Verify:** Mock LlmClient with canned responses, verify event sequence. `just test` + `just check`

---

## P2-7d: SSE Endpoint + AI Routes

**Goal:** HTTP endpoints connecting agent loop to clients.

**Create:** `routes/ai.ts`, `ai/sse.ts`

**Modify:**
- `server.ts` — add `registerAiRoutes(app, ctx)`
- `context.ts` — extend `AppContext` with `toolRegistry`, `conversationStore`
- `cli.ts` — initialize registry + conversation store in daemon startup

**SSE helper (`sse.ts`):**

```ts
function initSse(reply: FastifyReply): void     // writeHead 200, text/event-stream
function sendSseEvent(reply: FastifyReply, event: string, data: unknown): void
function endSse(reply: FastifyReply): void      // reply.raw.end()
```

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/ai/chat` | SSE streaming — validate → initSse → runAgentLoop → events → endSse |
| `GET` | `/ai/conversations` | List active conversations |
| `DELETE` | `/ai/conversations/:id` | Clear conversation |
| `GET` | `/ai/capabilities` | Return tool registry |
| `POST` | `/ai/preview/apply` | Apply external preview (P2-7e) |

**Key details:**
- Validation errors (missing message, LLM not configured) use `fail()` BEFORE `initSse()`. Once SSE starts, errors go through `sendSseEvent`.
- Client disconnect: `req.raw.on('close')` sets abort flag, agent loop checks between iterations.
- LlmClient created per-request for config hot-reload.

**AppContext extension:**

```ts
export interface AppContext {
  db: OwlDatabase; sqlite: Database.Database; config: OwlConfig
  configPath?: string; logger: Logger; deviceId: string; scheduler: ReminderScheduler
  toolRegistry: ToolRegistry          // NEW
  conversationStore: ConversationStore // NEW
}
```

**Verify:** `curl -N -X POST localhost:47010/ai/chat -H 'Content-Type: application/json' -d '{"message":"hello"}'` returns SSE events. `just test` + `just check`

---

## P2-7e: Write Tools + Draft/Preview

**Goal:** `create_note`, `update_note`, `apply_update` with source-dependent behavior.

**Create:** `tools/create-note.ts`, `tools/update-note.ts`, `tools/apply-update.ts`, `ai/preview-store.ts`

**Modify:** `tool-registry.ts`, `routes/ai.ts`, `agent-loop.ts`

**Write tool result structure:**

```ts
interface WriteToolResult {
  message: string           // Text shown to LLM as tool result
  sideEffect?: {
    type: 'draft_ready' | 'preview_ready'
    payload: Record<string, unknown>
  }
}
```

Agent loop detects `sideEffect` and yields it as AgentEvent before `tool_result`.

**source=gui (draft):**
- `create_note`: generate `draft_${randomUUID()}`, emit `draft_ready` (no DB write)
- `update_note`: read existing note, emit `draft_ready` with `original_content` + `original_tags`

**source=external (preview):**
- Store in `PreviewStore` (in-memory Map, 30min TTL auto-cleanup)
- Emit `preview_ready`
- `apply_update` / `POST /ai/preview/apply` executes stored preview against DB

**draft_ready payload (from design doc 6.4):**

```ts
{
  action: 'create' | 'update'
  note_id: string           // draft_xxx for create, real ID for update
  content: string
  tags: string[]
  folder_id: string | null
  original_content?: string  // update only — DB baseline
  original_tags?: string[]   // update only
}
```

**GUI-side changes (minimal — full chat UI is P2-8):**
- editorStore extensions: `isDraft` on TabState, `folderId` field, `pendingAiUpdate` field
- `saveNote` branch: isDraft → POST /notes, replace noteId, clear isDraft
- Full SSE event handling and conflict dialog UI deferred to P2-8

**Verify:** Write tools with source=gui return draft_ready (no DB write). source=external stores preview, apply_update writes to DB. `just test` + `just check`

---

## Dependency Graph

```
P2-7a (LLM Client)
    ↓
P2-7b (Tool Registry + Read/Specialized Tools)  ← partially independent of 7a
    ↓
P2-7c (Agent Loop + Conversations)  ← needs 7a + 7b
    ↓
P2-7d (SSE Endpoint + Routes)       ← needs 7c
    ↓
P2-7e (Write Tools + Draft/Preview) ← needs 7b + 7d
```

## Risks

1. **SDK ESM compat** — daemon is `"type": "module"`. Test early in P2-7a.
2. **Stream reassembly** — tool_call arguments split across delta chunks. Adapter must be thorough.
3. **Fastify + SSE** — raw headers written → Fastify reply helpers unusable. All SSE error handling must be explicit.
4. **Concurrent conversations** — ConversationStore isolated per-conversation; `better-sqlite3` serializes. Should be safe.

## Key Existing Files

- `packages/daemon/src/server.ts` — route registration
- `packages/daemon/src/context.ts` — AppContext definition
- `packages/daemon/src/cli.ts` — daemon startup
- `packages/daemon/src/response.ts` — ok/fail/created helpers
- `packages/core/src/config/index.ts` — OwlConfig, AiConfig, LlmConfig, resolveLlmConfig
- `packages/core/src/notes/index.ts` — listNotes, getNote, createNote, updateNote
- `packages/core/src/search/index.ts` — searchNotes, searchNotesWithDetails (FTS5)
- `packages/core/src/folders/index.ts` — listFolders
- `packages/core/src/reminders/index.ts` — reminder queries
- `packages/daemon/src/routes/todos.ts` — todo parsing regex (to copy)
- `packages/daemon/src/routes/tags.ts` — tag/reminder query patterns (to reference)
