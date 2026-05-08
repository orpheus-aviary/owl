import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Persistence layer for AI chat history (`ai_conversations` + `ai_messages`).
 *
 * Provider-agnostic: rows are described in storage shape, not in
 * `LlmMessage`. The daemon-side `ConversationStore` translates between
 * `LlmMessage` and `ConversationMessageRow`. Keeping the LLM types out of
 * core lets `@owl/core` stay free of provider SDK leaks.
 *
 * P4 Phase 1 convergence: every mutation against ai_* tables flows through
 * this module so Phase 2 can append `sync_changes` rows in the same
 * transaction.
 */

export interface ConversationMessageRow {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** JSON-encoded tool_calls array; only non-null on assistant rows that issued tool calls. */
  tool_calls: string | null;
  /** Only non-null on role='tool' rows. */
  tool_call_id: string | null;
  /** 0/1; only on role='tool'; null otherwise. */
  is_error: number | null;
  reasoning_content: string | null;
  reasoning_signature: string | null;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
}

export interface HydratedConversation {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  messages: ConversationMessageRow[];
}

const TITLE_MAX = 32;

function titleFrom(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '新对话';
  return collapsed.length > TITLE_MAX ? `${collapsed.slice(0, TITLE_MAX)}…` : collapsed;
}

/**
 * Atomically append messages for one agent-loop iteration.
 *
 * Single transaction:
 *   1. INSERT ai_conversations if id is new (title from first user message)
 *   2. INSERT ai_messages × N with monotonic seq
 *   3. UPDATE ai_conversations.updated_at
 */
export function appendConversationMessages(
  sqlite: Database.Database,
  conversationId: string,
  rows: ConversationMessageRow[],
  now: number,
): void {
  if (rows.length === 0) return;

  sqlite
    .transaction(() => {
      ensureConversationRow(sqlite, conversationId, rows, now);
      const startSeq = peekMaxSeq(sqlite, conversationId);
      insertMessages(sqlite, conversationId, rows, now, startSeq);
      bumpUpdatedAt(sqlite, conversationId, now);
    })
    .immediate();
}

function ensureConversationRow(
  sqlite: Database.Database,
  id: string,
  rows: ConversationMessageRow[],
  now: number,
): void {
  const existsRow = sqlite.prepare('SELECT 1 FROM ai_conversations WHERE id = ?').get(id) as
    | { 1: number }
    | undefined;
  if (existsRow) return;
  const firstUser = rows.find((r) => r.role === 'user');
  const title = titleFrom(firstUser ? firstUser.content : '新对话');
  sqlite
    .prepare('INSERT INTO ai_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, title, now, now);
}

function peekMaxSeq(sqlite: Database.Database, id: string): number {
  const row = sqlite
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM ai_messages WHERE conversation_id = ?')
    .get(id) as { m: number };
  return row.m;
}

function insertMessages(
  sqlite: Database.Database,
  conversationId: string,
  rows: ConversationMessageRow[],
  now: number,
  startSeq: number,
): void {
  const insert = sqlite.prepare(
    `INSERT INTO ai_messages
        (id, conversation_id, role, content, tool_calls, tool_call_id,
         is_error, reasoning_content, reasoning_signature, created_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let seq = startSeq;
  for (const row of rows) {
    seq += 1;
    insert.run(
      randomUUID(),
      conversationId,
      row.role,
      row.content,
      row.tool_calls,
      row.tool_call_id,
      row.is_error,
      row.reasoning_content,
      row.reasoning_signature,
      now,
      seq,
    );
  }
}

function bumpUpdatedAt(sqlite: Database.Database, id: string, now: number): void {
  sqlite.prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?').run(now, id);
}

/**
 * Hard-delete a conversation and all its messages (FK cascade). Returns
 * true if a row was deleted.
 */
export function deleteConversation(sqlite: Database.Database, id: string): boolean {
  const res = sqlite.prepare('DELETE FROM ai_conversations WHERE id = ?').run(id);
  return res.changes > 0;
}

/**
 * Sidebar list, ordered by most recent activity.
 */
export function listConversationSummaries(sqlite: Database.Database): ConversationSummary[] {
  const rows = sqlite
    .prepare(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM ai_conversations c
         ORDER BY c.updated_at DESC`,
    )
    .all() as {
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
 * Read the full message history for an id, ordered by seq. Returns
 * undefined if the conversation row doesn't exist.
 */
export function hydrateConversation(
  sqlite: Database.Database,
  id: string,
): HydratedConversation | undefined {
  const meta = sqlite
    .prepare('SELECT id, created_at, updated_at FROM ai_conversations WHERE id = ?')
    .get(id) as { id: string; created_at: number; updated_at: number } | undefined;
  if (!meta) return undefined;

  const rows = sqlite
    .prepare(
      `SELECT role, content, tool_calls, tool_call_id,
              is_error, reasoning_content, reasoning_signature
         FROM ai_messages
         WHERE conversation_id = ?
         ORDER BY seq ASC`,
    )
    .all(id) as ConversationMessageRow[];

  return {
    id: meta.id,
    createdAt: new Date(meta.created_at),
    updatedAt: new Date(meta.updated_at),
    messages: rows,
  };
}
