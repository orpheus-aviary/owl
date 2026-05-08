import { randomUUID } from 'node:crypto';
import {
  type ConversationMessageRow,
  type ConversationSummary,
  appendConversationMessages,
  deleteConversation,
  hydrateConversation,
  listConversationSummaries,
} from '@owl/core';
import type Database from 'better-sqlite3';
import type { LlmMessage, LlmToolCall } from './llm-client.js';

/**
 * SQLite-backed conversation store. The in-memory `Map` is still the hot
 * path for the agent loop (accessed per-turn, not per-token); a write-
 * through to `ai_conversations` / `ai_messages` snapshots each batch so
 * daemon restarts preserve history.
 *
 * P4 Phase 1: all DB writes delegate to `@owl/core/conversations`. This
 * class is now memory cache + `LlmMessage` ↔ row translation only.
 *
 * Write discipline (see P3.4-f design §4.1 / §10):
 *   - `runAgentLoop` NEVER touches `conversation.messages` directly.
 *   - `setSystemMessage` is memory-only (system prompt rebuilt every turn).
 *   - `appendMessages` is atomic per agent-loop iteration:
 *     `[user]` for the opening turn, `[assistant, ...toolResults]` for
 *     each subsequent round. One transaction per call (in core).
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
   * Filters role='system' (memory-only) and delegates the transaction to
   * `core.appendConversationMessages`. Memory cache is updated in lockstep.
   */
  appendMessages(id: string, msgs: LlmMessage[]): void {
    const conv = this.conversations.get(id);
    if (!conv) throw new Error(`Conversation not found: ${id}`);
    if (msgs.length === 0) return;

    // Filter system defensively — agent loop should already know not to
    // send us system here, but a sanity skip is cheap.
    const persistable = msgs.filter((m) => m.role !== 'system');
    const now = Date.now();

    appendConversationMessages(this.sqlite, id, persistable.map(toRow), now);

    // Mirror to in-memory cache (full msgs incl. system if any sneaks in).
    conv.messages.push(...msgs);
    conv.updatedAt = new Date(now);
  }

  delete(id: string): boolean {
    const hadMemory = this.conversations.delete(id);
    const removed = deleteConversation(this.sqlite, id);
    return hadMemory || removed;
  }

  list(): ConversationSummary[] {
    return listConversationSummaries(this.sqlite);
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
   * Rebuild a Conversation from `ai_conversations` + `ai_messages` via
   * `core.hydrateConversation`. System is not in DB (§4.1); callers should
   * invoke `setSystemMessage` afterward before the next LLM call.
   */
  private hydrateFromDb(id: string): Conversation | undefined {
    const hydrated = hydrateConversation(this.sqlite, id);
    if (!hydrated) return undefined;
    return {
      id: hydrated.id,
      createdAt: hydrated.createdAt,
      updatedAt: hydrated.updatedAt,
      messages: hydrated.messages.map(rowToLlmMessage),
    };
  }
}

function toRow(msg: LlmMessage): ConversationMessageRow {
  if (msg.role === 'system') {
    // Defensive: caller should filter, but keep the transform total.
    throw new Error('system messages must not reach core.appendConversationMessages');
  }
  return {
    role: msg.role,
    content: contentToString(msg.content),
    tool_calls: msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
    tool_call_id: msg.tool_call_id ?? null,
    is_error: msg.role === 'tool' ? (msg.is_error ? 1 : 0) : null,
    reasoning_content: msg.reasoning_content ?? null,
    reasoning_signature: msg.reasoning_signature ?? null,
  };
}

function rowToLlmMessage(r: ConversationMessageRow): LlmMessage {
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
}

function contentToString(content: LlmMessage['content']): string {
  if (typeof content === 'string') return content;
  // Rare: content blocks on inbound messages. Stringify as JSON so hydrate
  // can recover the shape. Agent loop normally passes plain strings.
  return JSON.stringify(content);
}
