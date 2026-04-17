# Chat Persistence + Sidebar — Plan

## Context

P2-8 shipped in-memory chat tabs: AI conversations live in `ai-store` (GUI)
and `ConversationStore` (daemon), both lose everything on restart. The
current `ChatTabBar` shows open chats only, no history.

User wants Claude-desktop-style UX: left sidebar lists all past chats by
creation time, searchable, persisted across daemon/GUI restarts. Tab bar
is replaced by a single main pane driven by sidebar selection.

## Decisions (agreed 2026-04-18)

- **Persistence store**: daemon SQLite (same `owl.db`), not GUI localStorage.
  Rationale: shared with CLI (P3), survives GUI reinstall, handled by the
  migration sync path we already have for notes.
- **UI layout**: sidebar + main pane. Remove `ChatTabBar`. Sidebar shows a
  vertical list ordered by `created_at DESC`, with a search box at top.
- **Streaming across switches**: allowed — when the user switches away from
  a streaming chat the SSE keeps running in the background. Second chat's
  send works independently (new fetch + new tab entry on ai-store). Returning
  to the first chat shows whatever progress happened while away.
- **Out of scope (deferred)**: unread indicators, last-message preview
  under each sidebar entry, per-chat folder tagging, export.

## Schema (daemon SQLite, idempotent migrations via `migrateSchema`)

```sql
CREATE TABLE IF NOT EXISTS ai_conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,    -- unix ms
  updated_at INTEGER NOT NULL     -- unix ms; bumped on each message append
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,  -- 'user' | 'assistant' | 'system' | 'tool'
  content         TEXT NOT NULL,  -- user/assistant/system: plain text; tool: JSON result
  tool_calls      TEXT,           -- JSON array on assistant messages that issued tool calls
  tool_call_id    TEXT,           -- non-null on role='tool' rows
  created_at      INTEGER NOT NULL,
  seq             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_messages_convo_seq
  ON ai_messages(conversation_id, seq);
```

Drafts (`draft_ready` card contents) and note_applied notices are NOT stored
— they're transient UI artefacts. On restart, past assistant messages render
without their DraftReadyCard until the user sends a new message. Acceptable
tradeoff; full event replay would bloat the schema.

## Daemon changes

1. `ConversationStore` persists via the new tables. In-memory cache stays as
   the hot path; reads fall back to DB if not cached.
2. New routes:
   - `GET /ai/conversations` already exists — extend to return stored rows
     (currently in-memory only).
   - `GET /ai/conversations/:id` — fetch a full conversation with messages.
   - `DELETE /ai/conversations/:id` already exists — cascade-delete messages.
   - (optional) `PATCH /ai/conversations/:id` — rename title.
3. `runAgentLoop`: wrap each `conversations.append(...)` in a DB INSERT so
   crash-during-stream doesn't lose user/assistant turns already committed
   to memory.

## GUI changes

1. `ai-store`:
   - Drop the flat `chats[]` tab model. Two new selectors instead:
     - `conversations: ConversationMeta[]` (sidebar list)
     - `activeConversationId: string | null`
     - `activeConversation: { meta, messages[], isStreaming, ... } | null`
   - Streaming state stored per-conversation so background sends work.
   - Fetch conversations on mount via `GET /ai/conversations`.
2. `AIPage`: left `ChatSidebar`, right `MessageList` + `ChatInput`.
   Remove `ChatTabBar`.
3. New `ChatSidebar.tsx`:
   - Top: "新建对话" button + search box (filters by title, client-side).
   - Scrolling list: each item = title + relative time.
   - Click = set active. Right-click = delete (goes through confirm).
4. `MessageList` / `MessageBubble`: unchanged modulo the selector shape.

## Implementation order

1. Daemon schema migration + ConversationStore SQLite backing + tests.
2. GUI `ai-store` shape change + sidebar wiring.
3. Rip out `ChatTabBar`, add `ChatSidebar`.
4. Manual E2E: restart daemon mid-stream, restart GUI, verify history
   persistence and background-streaming behaviour.

## Out of scope — recorded for future

- Unread / last-message preview (C-option E in original discussion).
- DraftReadyCard / note_applied replay on history load.
- Per-conversation search (full-text inside messages).
- Export to Markdown / JSON.
