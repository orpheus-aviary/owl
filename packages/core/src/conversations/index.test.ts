import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type Database from 'better-sqlite3';
import { createDatabase } from '../db/index.js';
import {
  type ConversationMessageRow,
  appendConversationMessages,
  deleteConversation,
  hydrateConversation,
  listConversationSummaries,
} from './index.js';

function userMsg(content: string): ConversationMessageRow {
  return {
    role: 'user',
    content,
    tool_calls: null,
    tool_call_id: null,
    is_error: null,
    reasoning_content: null,
    reasoning_signature: null,
  };
}

function assistantMsg(
  content: string,
  opts: Partial<ConversationMessageRow> = {},
): ConversationMessageRow {
  return {
    role: 'assistant',
    content,
    tool_calls: opts.tool_calls ?? null,
    tool_call_id: null,
    is_error: null,
    reasoning_content: opts.reasoning_content ?? null,
    reasoning_signature: opts.reasoning_signature ?? null,
  };
}

function toolMsg(content: string, toolCallId: string, isError: boolean): ConversationMessageRow {
  return {
    role: 'tool',
    content,
    tool_calls: null,
    tool_call_id: toolCallId,
    is_error: isError ? 1 : 0,
    reasoning_content: null,
    reasoning_signature: null,
  };
}

function clearAll(sqlite: Database.Database): void {
  sqlite.prepare('DELETE FROM ai_messages').run();
  sqlite.prepare('DELETE FROM ai_conversations').run();
}

describe('appendConversationMessages', () => {
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    sqlite = result.sqlite;
  });

  beforeEach(() => {
    clearAll(sqlite);
  });

  after(() => {
    sqlite.close();
  });

  it('creates the conversation row on first append, with title from first user message', () => {
    const id = 'conv-1';
    const now = Date.now();
    appendConversationMessages(sqlite, id, [userMsg('hello world')], now);

    const row = sqlite
      .prepare('SELECT id, title, created_at, updated_at FROM ai_conversations WHERE id = ?')
      .get(id) as { id: string; title: string; created_at: number; updated_at: number };
    assert.equal(row.id, id);
    assert.equal(row.title, 'hello world');
    assert.equal(row.created_at, now);
    assert.equal(row.updated_at, now);

    const msgCount = sqlite
      .prepare('SELECT COUNT(*) AS c FROM ai_messages WHERE conversation_id = ?')
      .get(id) as { c: number };
    assert.equal(msgCount.c, 1);
  });

  it('truncates very long titles to 32 chars + ellipsis', () => {
    const id = 'conv-long';
    const long = 'a'.repeat(100);
    appendConversationMessages(sqlite, id, [userMsg(long)], Date.now());

    const row = sqlite.prepare('SELECT title FROM ai_conversations WHERE id = ?').get(id) as {
      title: string;
    };
    assert.equal(row.title, `${'a'.repeat(32)}…`);
  });

  it('does not create a row again on subsequent calls; bumps updated_at', () => {
    const id = 'conv-2';
    const t1 = 1_000_000;
    const t2 = 1_000_500;

    appendConversationMessages(sqlite, id, [userMsg('first')], t1);
    appendConversationMessages(sqlite, id, [assistantMsg('reply')], t2);

    const row = sqlite
      .prepare('SELECT created_at, updated_at FROM ai_conversations WHERE id = ?')
      .get(id) as { created_at: number; updated_at: number };
    assert.equal(row.created_at, t1);
    assert.equal(row.updated_at, t2);

    const seqs = sqlite
      .prepare('SELECT seq FROM ai_messages WHERE conversation_id = ? ORDER BY seq')
      .all(id) as { seq: number }[];
    assert.deepEqual(
      seqs.map((s) => s.seq),
      [1, 2],
    );
  });

  it('persists tool_calls JSON, tool_call_id, is_error, reasoning fields', () => {
    const id = 'conv-3';
    const toolCallsJson = JSON.stringify([{ id: 'call_1', name: 'noop', arguments: '{}' }]);

    appendConversationMessages(
      sqlite,
      id,
      [
        userMsg('do thing'),
        assistantMsg('working', {
          tool_calls: toolCallsJson,
          reasoning_content: 'thinking…',
          reasoning_signature: 'sig-abc',
        }),
        toolMsg('tool result', 'call_1', false),
        toolMsg('boom', 'call_2', true),
      ],
      Date.now(),
    );

    const rows = sqlite
      .prepare(
        `SELECT role, content, tool_calls, tool_call_id, is_error,
                reasoning_content, reasoning_signature
           FROM ai_messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(id) as {
      role: string;
      content: string;
      tool_calls: string | null;
      tool_call_id: string | null;
      is_error: number | null;
      reasoning_content: string | null;
      reasoning_signature: string | null;
    }[];

    assert.equal(rows[1].tool_calls, toolCallsJson);
    assert.equal(rows[1].reasoning_content, 'thinking…');
    assert.equal(rows[1].reasoning_signature, 'sig-abc');
    assert.equal(rows[2].tool_call_id, 'call_1');
    assert.equal(rows[2].is_error, 0);
    assert.equal(rows[3].tool_call_id, 'call_2');
    assert.equal(rows[3].is_error, 1);
  });

  it('is a no-op for an empty rows array', () => {
    const id = 'conv-empty';
    appendConversationMessages(sqlite, id, [], Date.now());

    const exists = sqlite.prepare('SELECT 1 FROM ai_conversations WHERE id = ?').get(id) as
      | { 1: number }
      | undefined;
    assert.equal(exists, undefined);
  });

  it('uses fallback title when first append has no user message', () => {
    const id = 'conv-no-user';
    appendConversationMessages(sqlite, id, [assistantMsg('orphan')], Date.now());

    const row = sqlite.prepare('SELECT title FROM ai_conversations WHERE id = ?').get(id) as {
      title: string;
    };
    assert.equal(row.title, '新对话');
  });
});

describe('deleteConversation', () => {
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    sqlite = result.sqlite;
  });

  beforeEach(() => {
    clearAll(sqlite);
  });

  after(() => {
    sqlite.close();
  });

  it('removes the conversation and cascades to messages', () => {
    const id = 'conv-delete';
    appendConversationMessages(sqlite, id, [userMsg('a'), assistantMsg('b')], Date.now());

    const removed = deleteConversation(sqlite, id);
    assert.equal(removed, true);

    const conv = sqlite.prepare('SELECT 1 FROM ai_conversations WHERE id = ?').get(id) as
      | { 1: number }
      | undefined;
    assert.equal(conv, undefined);

    const msgs = sqlite
      .prepare('SELECT COUNT(*) AS c FROM ai_messages WHERE conversation_id = ?')
      .get(id) as { c: number };
    assert.equal(msgs.c, 0);
  });

  it('returns false for a non-existent id', () => {
    assert.equal(deleteConversation(sqlite, 'no-such-id'), false);
  });
});

describe('hydrateConversation', () => {
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    sqlite = result.sqlite;
  });

  beforeEach(() => {
    clearAll(sqlite);
  });

  after(() => {
    sqlite.close();
  });

  it('returns undefined when id not found', () => {
    assert.equal(hydrateConversation(sqlite, 'missing'), undefined);
  });

  it('returns rows ordered by seq with reasoning fields preserved', () => {
    const id = 'conv-hydrate';
    appendConversationMessages(
      sqlite,
      id,
      [userMsg('q'), assistantMsg('a', { reasoning_content: 'r', reasoning_signature: 'sig' })],
      1_111_111,
    );

    const hydrated = hydrateConversation(sqlite, id);
    assert.ok(hydrated);
    assert.equal(hydrated.id, id);
    assert.equal(hydrated.createdAt.getTime(), 1_111_111);
    assert.equal(hydrated.messages.length, 2);
    assert.equal(hydrated.messages[0].role, 'user');
    assert.equal(hydrated.messages[1].role, 'assistant');
    assert.equal(hydrated.messages[1].reasoning_content, 'r');
    assert.equal(hydrated.messages[1].reasoning_signature, 'sig');
  });
});

describe('listConversationSummaries', () => {
  let sqlite: Database.Database;

  before(() => {
    const result = createDatabase({ dbPath: ':memory:' });
    sqlite = result.sqlite;
  });

  beforeEach(() => {
    clearAll(sqlite);
  });

  after(() => {
    sqlite.close();
  });

  it('returns conversations ordered by updated_at DESC, with messageCount', () => {
    appendConversationMessages(sqlite, 'older', [userMsg('a')], 1_000);
    appendConversationMessages(sqlite, 'newer', [userMsg('b'), assistantMsg('c')], 2_000);

    const list = listConversationSummaries(sqlite);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'newer');
    assert.equal(list[0].messageCount, 2);
    assert.equal(list[1].id, 'older');
    assert.equal(list[1].messageCount, 1);
  });
});
