import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { LlmMessage, LlmToolCall } from './llm-client.js';

/**
 * SQLite-backed conversation store. The in-memory `Map` is still the hot
 * path for the agent loop (accessed per-turn, not per-token); a write-
 * through to `ai_conversations` / `ai_messages` snapshots each batch so
 * daemon restarts preserve history.
 *
 * Write discipline (see P3.4-f design §4.1 / §10):
 *   - `runAgentLoop` NEVER touches `conversation.messages` directly.
 *   - `setSystemMessage` is memory-only (system prompt rebuilt every turn).
 *   - `appendMessages` is atomic per agent-loop iteration:
 *     `[user]` for the opening turn, `[assistant, ...toolResults]` for
 *     each subsequent round. One transaction per call.
 *   - On first `appendMessages` for a new id, the `ai_conversations` row
 *     is inserted in the same transaction, with the title derived from
 *     the first user message.
 *
 * Read discipline:
 *   - `getOrCreate(id)` miss-fills from DB by reading ai_messages ORDER
 *     BY seq and rebuilding LlmMessage[] (including reasoning fields),
 *     then trims to `config.ai.context_rounds` before the next LLM call
 *     can burn tokens on a long history.
 *   - `list()` reads ai_conversations ordered by updated_at DESC.
 */
export interface Conversation {
  id: string;
  messages: LlmMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
}

const TITLE_MAX = 32;

function titleFrom(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '新对话';
  return collapsed.length > TITLE_MAX ? `${collapsed.slice(0, TITLE_MAX)}…` : collapsed;
}

function extractUserText(msg: LlmMessage): string {
  // In practice agent loop passes plain strings for user messages; blocks
  // would only appear via hydration + re-append (unlikely), so flatten
  // defensively rather than recurse.
  if (typeof msg.content === 'string') return msg.content;
  return JSON.stringify(msg.content);
}

export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  constructor(private readonly sqlite: Database.Database) {}

  /**
   * Load-or-create. Hydrates from DB when the id is known but not cached.
   * New conversations live in memory only until the first `appendMessages`
   * commits the row.
   */
  getOrCreate(id?: string): { conversation: Conversation; created: boolean } {
    if (id) {
      const cached = this.conversations.get(id);
      if (cached) return { conversation: cached, created: false };
      const hydrated = this.hydrateFromDb(id);
      if (hydrated) {
        this.conversations.set(id, hydrated);
        return { conversation: hydrated, created: false };
      }
    }
    const newId = id ?? randomUUID();
    const now = new Date();
    const conversation: Conversation = {
      id: newId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(newId, conversation);
    return { conversation, created: true };
  }

  get(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  /**
   * Replace the index-0 system message in memory. Memory-only: the system
   * prompt is rebuilt fresh by `buildSystemPrompt()` every turn, so
   * persisting it would just be stale bytes. The DB `role` CHECK rejects
   * 'system' anyway, as a defensive floor.
   */
  setSystemMessage(id: string, content: string): void {
    const conv = this.conversations.get(id);
    if (!conv) throw new Error(`Conversation not found: ${id}`);
    const sysMsg: LlmMessage = { role: 'system', content };
    if (conv.messages[0]?.role === 'system') {
      conv.messages[0] = sysMsg;
    } else {
      conv.messages.unshift(sysMsg);
    }
  }

  /**
   * Atomically append a batch of messages for one agent-loop iteration.
   * Single transaction:
   *   - First call for an id → INSERT ai_conversations
   *   - INSERT ai_messages × N with monotonic seq
   *   - UPDATE ai_conversations.updated_at = now()
   * Memory is updated in the same call so cache + DB don't diverge.
   * Skips role='system' at the API layer; the SQL CHECK catches any
   * future code path that bypasses this skip.
   */
  appendMessages(id: string, msgs: LlmMessage[]): void {
    const conv = this.conversations.get(id);
    if (!conv) throw new Error(`Conversation not found: ${id}`);
    if (msgs.length === 0) return;

    // Filter system defensively — agent loop should already know not to
    // send us system here, but a sanity skip is cheap.
    const persistable = msgs.filter((m) => m.role !== 'system');
    const now = Date.now();

    this.sqlite
      .transaction(() => {
        this.ensureConversationRow(id, persistable, now);
        const startSeq = this.peekMaxSeq(id);
        this.insertMessages(id, persistable, now, startSeq);
        this.bumpUpdatedAt(id, now);
      })
      .immediate();

    // Mirror to in-memory cache.
    conv.messages.push(...msgs);
    conv.updatedAt = new Date(now);
  }

  private ensureConversationRow(id: string, persistable: LlmMessage[], now: number): void {
    const EXISTS_SQL = 'SELECT 1 FROM ai_conversations WHERE id = ?';
    const existsRow = this.sqlite.prepare(EXISTS_SQL).get(id) as { 1: number } | undefined;
    if (existsRow) return;
    const firstUser = persistable.find((m) => m.role === 'user');
    const title = titleFrom(firstUser ? extractUserText(firstUser) : '新对话');
    const INSERT_SQL =
      'INSERT INTO ai_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)';
    this.sqlite.prepare(INSERT_SQL).run(id, title, now, now);
  }

  private peekMaxSeq(id: string): number {
    const MAX_SQL = 'SELECT COALESCE(MAX(seq), 0) AS m FROM ai_messages WHERE conversation_id = ?';
    const row = this.sqlite.prepare(MAX_SQL).get(id) as { m: number };
    return row.m;
  }

  private insertMessages(id: string, msgs: LlmMessage[], now: number, startSeq: number): void {
    const INSERT_SQL = `INSERT INTO ai_messages
        (id, conversation_id, role, content, tool_calls, tool_call_id,
         is_error, reasoning_content, reasoning_signature, created_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const insert = this.sqlite.prepare(INSERT_SQL);
    let seq = startSeq;
    for (const msg of msgs) {
      seq += 1;
      insert.run(
        randomUUID(),
        id,
        msg.role,
        contentToString(msg.content),
        msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
        msg.tool_call_id ?? null,
        msg.role === 'tool' ? (msg.is_error ? 1 : 0) : null,
        msg.reasoning_content ?? null,
        msg.reasoning_signature ?? null,
        now,
        seq,
      );
    }
  }

  private bumpUpdatedAt(id: string, now: number): void {
    const SQL = 'UPDATE ai_conversations SET updated_at = ? WHERE id = ?';
    this.sqlite.prepare(SQL).run(now, id);
  }

  delete(id: string): boolean {
    const hadMemory = this.conversations.delete(id);
    const res = this.sqlite.prepare('DELETE FROM ai_conversations WHERE id = ?').run(id);
    return hadMemory || res.changes > 0;
  }

  list(): ConversationSummary[] {
    const LIST_SQL = `
      SELECT c.id, c.title, c.created_at, c.updated_at,
             (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS message_count
      FROM ai_conversations c
      ORDER BY c.updated_at DESC
    `;
    const rows = this.sqlite.prepare(LIST_SQL).all() as {
      id: string;
      title: string;
      created_at: number;
      updated_at: number;
      message_count: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
      messageCount: r.message_count,
    }));
  }

  /**
   * Trim the conversation to the last `maxRounds` user→assistant pairs.
   * A "round" starts at a user message and ends at the next user message
   * (or end of list). Tool call/result pairs inside a round stay together.
   * The system message (always at index 0 if present) is preserved.
   *
   * Memory-only: we never delete from DB — sidebar always shows the full
   * history, only the LLM context window is bounded.
   */
  trimToRounds(id: string, maxRounds: number): void {
    const conv = this.conversations.get(id);
    if (!conv || maxRounds <= 0) return;

    const { messages } = conv;
    const systemPrefix: LlmMessage[] = [];
    let i = 0;
    while (i < messages.length && messages[i].role === 'system') {
      systemPrefix.push(messages[i]);
      i++;
    }

    const userTurnStarts: number[] = [];
    for (let j = i; j < messages.length; j++) {
      if (messages[j].role === 'user') userTurnStarts.push(j);
    }

    if (userTurnStarts.length <= maxRounds) return;

    const dropFrom = userTurnStarts[userTurnStarts.length - maxRounds];
    conv.messages = [...systemPrefix, ...messages.slice(dropFrom)];
    conv.updatedAt = new Date();
  }

  // ── internals ────────────────────────────────────────────────────────

  /**
   * Rebuild a Conversation from `ai_conversations` + `ai_messages`. System
   * is not in DB (§4.1); callers should invoke `setSystemMessage` afterward
   * before the next LLM call. Returns undefined if the id isn't in DB.
   */
  private hydrateFromDb(id: string): Conversation | undefined {
    const CONVO_SQL = 'SELECT id, created_at, updated_at FROM ai_conversations WHERE id = ?';
    const meta = this.sqlite.prepare(CONVO_SQL).get(id) as
      | { id: string; created_at: number; updated_at: number }
      | undefined;
    if (!meta) return undefined;

    const MSG_SQL = `
      SELECT role, content, tool_calls, tool_call_id,
             is_error, reasoning_content, reasoning_signature
      FROM ai_messages
      WHERE conversation_id = ?
      ORDER BY seq ASC
    `;
    const rows = this.sqlite.prepare(MSG_SQL).all(id) as {
      role: 'user' | 'assistant' | 'tool';
      content: string;
      tool_calls: string | null;
      tool_call_id: string | null;
      is_error: number | null;
      reasoning_content: string | null;
      reasoning_signature: string | null;
    }[];

    const messages: LlmMessage[] = rows.map((r) => {
      const msg: LlmMessage = { role: r.role, content: r.content };
      if (r.tool_calls) {
        msg.tool_calls = JSON.parse(r.tool_calls) as LlmToolCall[];
      }
      if (r.tool_call_id !== null) msg.tool_call_id = r.tool_call_id;
      if (r.is_error !== null && r.role === 'tool') {
        msg.is_error = r.is_error === 1;
      }
      if (r.reasoning_content !== null) msg.reasoning_content = r.reasoning_content;
      if (r.reasoning_signature !== null) msg.reasoning_signature = r.reasoning_signature;
      return msg;
    });

    return {
      id: meta.id,
      messages,
      createdAt: new Date(meta.created_at),
      updatedAt: new Date(meta.updated_at),
    };
  }
}

function contentToString(content: LlmMessage['content']): string {
  if (typeof content === 'string') return content;
  // Rare: content blocks on inbound messages. Stringify as JSON so hydrate
  // can recover the shape. Agent loop normally passes plain strings.
  return JSON.stringify(content);
}
