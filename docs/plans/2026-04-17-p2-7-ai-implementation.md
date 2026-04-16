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
- **Write contract**: Two-tier — Tier 1 (`append_memo`, `add_todo`) direct DB write + `note_applied` event; Tier 2 (`create_note`, `update_note`, `create_reminder`) draft (source=gui) / preview (source=external). Defined in P2-7b, Tier-2 tools implemented in P2-7e.
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
│   ├── create-reminder.ts # P2-7e
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

## P2-7b: Tool Registry + Read/Tier-1 Write Tools

**Goal:** Registry of 9 tools (7 read + 2 Tier-1 write) callable standalone. Tier-2 write tools added in P2-7e.

**Create:** `tool-registry.ts` + 9 files under `tools/`

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

**Write tool contract (defined here, used by P2-7b Tier-1 tools + P2-7e Tier-2 tools):**

All DB-modifying tools return a shared result shape; the agent loop (P2-7c) inspects `sideEffect` and yields a matching `AgentEvent` before the `tool_result`:

```ts
interface WriteToolResult {
  message: string           // Text shown to LLM as tool result
  sideEffect?: {
    type: 'note_applied' | 'draft_ready' | 'preview_ready'
    payload: Record<string, unknown>
  }
}
```

Two tiers:

| Tier | Tools | Behavior |
|------|-------|----------|
| Tier 1 (direct) | `append_memo`, `add_todo` | Tool writes DB itself, returns `sideEffect: note_applied`. Agent loop yields `note_applied { note_id, content, appended_text }`. GUI reconciles tab state — if target tab dirty, conflict UI (P2-8); else silent refresh. |
| Tier 2 (draft/preview) | `create_note`, `update_note`, `create_reminder` (all P2-7e) | Tool does NOT write DB; returns `sideEffect: draft_ready` (source=gui) or `preview_ready` (source=external). Actual write deferred to GUI save (draft) or `apply_update` (preview). |

Rationale: Tier 1 is append-only and low-risk; Tier 2 has multi-line content or scheduling side-effects that warrant user review.

**Tool implementations (each wraps existing core functions):**

| Tool | Tier | Core function | Notes |
|------|------|--------------|-------|
| `search_notes` | read | `searchNotesWithDetails` + `listNotes` | `max_chars` param truncates cumulative content. Empty query → recent by updated_at |
| `get_note` | read | `getNote(db, id)` | Full note + tags |
| `list_tags` | read | SQL from routes/tags.ts | search + limit params |
| `list_folders` | read | `listFolders(db)` | Flat list with parent_id |
| `get_reminders` | read | `listRemindersWithStatus` — NEW function in `packages/core/src/reminders/index.ts` | JOIN `notes` + `tags` + `reminder_status` for actual pending/fired state. Params: `status?` ('pending' \| 'fired' \| 'overdue'), `from?`, `to?`, `limit?`. Do NOT reuse SQL from `routes/tags.ts` — it only queries `/alarm`+`/time` tag values, has no status semantics. |
| `get_todos` | read | Inline todo regex parser | Copy regex from routes/todos.ts (sync note in comment) |
| `get_capabilities` | read | `registry.all()` | Return tool names + descriptions |
| `append_memo` | Tier 1 | `getNote` + `updateNote` | Append text to SPECIAL_NOTES.MEMO. Tool writes DB then returns `sideEffect: note_applied` with `{ note_id, content, appended_text }`. |
| `add_todo` | Tier 1 | `getNote` + `updateNote` | Append `- [ ] content` line to SPECIAL_NOTES.TODO. Same flow as `append_memo`. |

**Tier-2 tools (`create_note`, `update_note`, `create_reminder`) are defined in P2-7e.**

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
  | { type: 'note_applied'; note_id: string; content: string; appended_text: string }
  | { type: 'draft_ready'; action: 'create' | 'update' | 'create_reminder'; note_id: string; content: string; tags: string[]; folder_id: string | null; original_content?: string; original_tags?: string[]; original_folder_id?: string | null }
  | { type: 'preview_ready'; preview_id: string; action: string; diff: string; content: string; tags: string[]; folder_id?: string | null }
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
      - If result is `WriteToolResult` with `sideEffect` → yield matching event BEFORE `tool_result`: `note_applied` (Tier 1) / `draft_ready` / `preview_ready` (Tier 2, P2-7e)
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

**Config propagation (three places must stay in sync):**

Adding `max_context_chars: number` (default 30000) requires synced updates in:

1. `packages/core/src/config/index.ts` — `AiConfig` interface + `DEFAULT_CONFIG.ai` literal
2. `packages/gui/src/renderer/src/lib/api.ts` — `OwlConfig.ai` interface (currently hardcoded to `{ context_rounds, max_fts_notes, max_recent_notes }` at line 291)
3. `packages/gui/src/renderer/src/stores/config-store.ts` — `DEFAULT_AI` constant (line 43-47)

Settings page UI control deferred to P2-8. Missing any of the three locations will cause silent fallback to the hardcoded default or type mismatch.

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

## P2-7e: Tier-2 Write Tools + Draft/Preview

**Goal:** `create_note`, `update_note`, `create_reminder`, `apply_update` — all Tier-2 (tool does NOT write DB; emits `draft_ready` or `preview_ready` sideEffect). `WriteToolResult` shape is defined in P2-7b.

**Create:** `tools/create-note.ts`, `tools/update-note.ts`, `tools/create-reminder.ts`, `tools/apply-update.ts`, `ai/preview-store.ts`

**Modify:** `tool-registry.ts`, `routes/ai.ts`, `agent-loop.ts`

**Tool parameters (JSON Schema highlights):**

- `create_note`: `{ content: string, tags?: string[], folder_id?: string | null }`
- `update_note`: `{ note_id: string, content?: string, tags?: string[], folder_id?: string | null }` — all content/tags/folder optional; at least one required. Folder change is explicitly supported.
- `create_reminder`: `{ content: string, fire_at: string (ISO), tags?: string[], folder_id?: string | null }` — `/alarm` tag synthesized from `fire_at`.
- `apply_update`: `{ preview_id: string }` — applies a stored external preview.

**source=gui (draft):**
- `create_note`: generate `draft_${randomUUID()}`, emit `draft_ready` with `{ action: 'create', folder_id }` (no DB write)
- `update_note`: read existing note, emit `draft_ready` with `original_content` + `original_tags` + `original_folder_id` as DB baselines for conflict detection
- `create_reminder`: generate `draft_${randomUUID()}`, synthesize `/alarm` tag from `fire_at`, emit `draft_ready` with `{ action: 'create_reminder' }`. Scheduler hook fires when GUI saves the draft (normal `createNote` → `scheduler.onNoteChanged` flow applies).

**source=external (preview):**
- Store full payload (incl. `folder_id` for updates) in `PreviewStore` (in-memory Map, 30min TTL auto-cleanup)
- Emit `preview_ready`
- `apply_update` / `POST /ai/preview/apply` executes stored preview against DB — uses `patchNote`-style write so folder changes apply atomically with content/tags

**draft_ready payload:**

```ts
{
  action: 'create' | 'update' | 'create_reminder'
  note_id: string                     // draft_xxx for create/create_reminder, real ID for update
  content: string
  tags: string[]
  folder_id: string | null            // target folder (create: requested; update: requested or unchanged baseline)
  original_content?: string           // update only — DB baseline
  original_tags?: string[]            // update only — DB baseline
  original_folder_id?: string | null  // update only — DB baseline; used for folder conflict detection on save
}
```

**GUI-side changes (minimal — full chat UI is P2-8):**
- `editorStore` extensions on `TabState`:
  - NEW `isDraft: boolean` — true for `draft_xxx` IDs not yet POSTed
  - NEW `pendingAiUpdate` — full `draft_ready` payload (incl. all `original_*` baselines)
  - NEW `originalFolderId: string | null` — save baseline mirroring `folderId`, needed for conflict detection. Since folder moves persist immediately, `openNote` sets both from `note.folderId`, and `syncTabFolderId` updates both.
  - (`folderId` already exists on `TabState`, see `editor-store.ts:17`.)
- `saveNote` branches:
  - `isDraft=true` → `POST /notes` with `{ content, tags, folder_id }`, replace tab's `noteId` with returned real ID, clear `isDraft` and `pendingAiUpdate`
  - `isDraft=false` with `pendingAiUpdate` set → use `patchNote({ content, tags, folder_id })` (see `api.ts:155-158`) instead of `updateNote` (content/tags only, see `api.ts:152-153`). Needed because AI updates may change folder.
- Conflict checks on save (update drafts only) — compare **save baselines** against AI's assumed baselines, NOT the current edited values (which ARE the AI target and will always differ from baseline):
  - `tab.originalContent !== pendingAiUpdate.original_content` → content conflict (DB moved under AI)
  - `tab.originalTags` differs from `pendingAiUpdate.original_tags` → tag conflict
  - `tab.originalFolderId !== pendingAiUpdate.original_folder_id` → folder conflict (folder moved after AI drafted)
  - Rationale: mirrors the existing dirty model in `editor-store.ts:121, 135` — "baseline vs current". `original_*` on the pending update is AI's baseline; `tab.original*` is the tab's save baseline. Match ⇒ no concurrent change ⇒ safe to save. Defense-in-depth alternative (re-fetch DB before save) noted as future hardening.
- Full SSE event handling (`note_applied`, `draft_ready`, `preview_ready`) and conflict dialog UI deferred to P2-8

**Verify:** Tier-2 tools with source=gui return `draft_ready` with correct folder fields (no DB write). source=external stores preview, `apply_update` writes to DB including `folder_id`. Update drafts include `original_folder_id`. `just test` + `just check`

---

## Dependency Graph

```
P2-7a (LLM Client)
    ↓
P2-7b (Tool Registry + Read + Tier-1 Write)  ← partially independent of 7a
    ↓
P2-7c (Agent Loop + Conversations)  ← needs 7a + 7b
    ↓
P2-7d (SSE Endpoint + Routes)       ← needs 7c
    ↓
P2-7e (Tier-2 Write + Draft/Preview) ← needs 7b + 7d
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
- `packages/core/src/reminders/index.ts` — reminder queries (authoritative status via `reminder_status` table; extend with `listRemindersWithStatus` for `get_reminders` tool)
- `packages/daemon/src/routes/todos.ts` — todo parsing regex (to copy)
- `packages/daemon/src/routes/tags.ts` — tag query patterns only (its reminder SQL is status-blind; do NOT reuse for `get_reminders`)
- `packages/gui/src/renderer/src/lib/api.ts` — GUI config mirror (update `OwlConfig.ai` for `max_context_chars`)
- `packages/gui/src/renderer/src/stores/config-store.ts` — `DEFAULT_AI` constant (update for `max_context_chars`)
- `packages/gui/src/renderer/src/stores/editor-store.ts` — `TabState` with `folderId` (extend with `isDraft`, `pendingAiUpdate`, `originalFolderId` in P2-7e)
