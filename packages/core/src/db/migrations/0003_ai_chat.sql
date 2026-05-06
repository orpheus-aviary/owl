-- 0003_ai_chat.sql — ai_conversations + ai_messages (user_version = 3)
--
-- INVARIANT: Once shipped, this file is IMMUTABLE. Do not edit after 0.4.0.
-- Future schema changes go into 0004_*.sql, ...
--
-- `PRAGMA user_version = 3` is NOT set here — applyForwardMigrations() stamps
-- it after this file succeeds. Same convention as 0001_initial.sql / 0002_sorting.sql.
--
-- Non-destructive migration: pure CREATE TABLE + CREATE INDEX. Existing
-- notes / folders / tags untouched. Users with empty AI history see no
-- change; daemon restarts will begin populating these tables.

CREATE TABLE ai_conversations (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,       -- unix ms (P3.4-a convention)
  updated_at INTEGER NOT NULL        -- bumped on each appendMessages batch
);

-- system is NOT stored (agent loop rebuilds buildSystemPrompt() every turn).
-- CHECK on `role` is the defensive floor: a future refactor that forgets the
-- appendMessages skip would still be rejected by SQLite. It does NOT catch
-- an agent loop that bypasses the store entirely — see P3.4-f design §10.
CREATE TABLE ai_messages (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role                TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content             TEXT NOT NULL,
  tool_calls          TEXT,         -- JSON; only non-null on assistant rows that issued tool calls
  tool_call_id        TEXT,         -- only non-null on role='tool' rows
  is_error            INTEGER,      -- 0/1; only on role='tool'; GUI-hydration use (ChatToolCall.isError)
  reasoning_content   TEXT,         -- assistant thinking text (DeepSeek V4 + Anthropic round-trip)
  reasoning_signature TEXT,         -- Anthropic-only opaque signature; must round-trip verbatim
  created_at          INTEGER NOT NULL,
  seq                 INTEGER NOT NULL   -- per-conversation monotonic; ORDER BY seq to read
);

CREATE INDEX idx_ai_messages_convo_seq
  ON ai_messages(conversation_id, seq);

CREATE INDEX idx_ai_conversations_updated
  ON ai_conversations(updated_at DESC);
