import { randomUUID } from 'node:crypto';
import type { LlmMessage } from './llm-client.js';

/**
 * In-memory conversation store. Conversations live for the lifetime of the
 * daemon process — daemon restart wipes them. The agent loop is the sole
 * writer; routes and tests read via `get` / `list`.
 *
 * Trimming preserves the contract that every assistant `tool_calls` message
 * keeps its companion `tool` results — orphaning either side breaks both
 * OpenAI and Anthropic adapter translation, so trim points always fall on
 * a "clean" boundary (between top-level user/assistant turns, never inside
 * a tool round-trip).
 */
export interface Conversation {
  id: string;
  messages: LlmMessage[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationSummary {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
}

export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  /**
   * Look up a conversation by id; create a new one if `id` is undefined or
   * not yet known. Returns `{ conversation, created }` so the caller can
   * decide whether to seed the system prompt.
   */
  getOrCreate(id?: string): { conversation: Conversation; created: boolean } {
    if (id) {
      const existing = this.conversations.get(id);
      if (existing) return { conversation: existing, created: false };
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
   * Append messages and bump `updatedAt`. The agent loop calls this after
   * each LLM round-trip with the assistant message and any tool results.
   */
  append(id: string, messages: LlmMessage[]): void {
    const conv = this.conversations.get(id);
    if (!conv) throw new Error(`Conversation not found: ${id}`);
    conv.messages.push(...messages);
    conv.updatedAt = new Date();
  }

  delete(id: string): boolean {
    return this.conversations.delete(id);
  }

  list(): ConversationSummary[] {
    return [...this.conversations.values()].map((c) => ({
      id: c.id,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
    }));
  }

  /**
   * Trim the conversation to the last `maxRounds` user→assistant pairs.
   * A "round" starts at a user message and ends at the next user message
   * (or end of list). Tool call/result pairs inside a round stay together.
   * The system message (always at index 0 if present) is preserved.
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
}
