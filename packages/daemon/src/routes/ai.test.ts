import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type LlmConfig,
  type OwlConfig,
  type OwlDatabase,
  createConsoleLogger,
  createDatabase,
  ensureDeviceId,
  ensureSpecialNotes,
} from '@owl/core';
import type Database from 'better-sqlite3';
import { ConversationStore } from '../ai/conversations.js';
import type { LlmClient, LlmMessage, LlmToolDef, StreamChunk } from '../ai/llm-client.js';
import { PreviewStore } from '../ai/preview-store.js';
import { createBuiltinRegistry } from '../ai/tools/index.js';
import { EventsBus } from '../events/bus.js';
import { ReminderScheduler } from '../scheduler.js';
import { buildTestServer } from '../testing/build-test-server.js';

// ─── Mock LLM ──────────────────────────────────────────────────────────

class QueuedLlmClient implements LlmClient {
  constructor(private readonly chunkQueue: StreamChunk[][]) {}
  async *chatCompletion(_messages: LlmMessage[], _tools: LlmToolDef[]): AsyncIterable<StreamChunk> {
    const next = this.chunkQueue.shift();
    if (!next) throw new Error('QueuedLlmClient: chunk queue exhausted');
    for (const chunk of next) yield chunk;
  }
}

interface SseEvent {
  event: string;
  data: unknown;
}

/** Parse a raw SSE payload (one or more `event:` / `data:` blocks). */
function parseSseEvents(raw: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of raw.split(/\n\n/)) {
    if (!block.trim()) continue;
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (!event) continue;
    let data: unknown = dataLines.join('\n');
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      // leave as string
    }
    out.push({ event, data });
  }
  return out;
}

// ─── Test fixtures ─────────────────────────────────────────────────────

describe('AI routes (P2-7d)', () => {
  let app: ReturnType<typeof buildTestServer>;
  let db: OwlDatabase;
  let sqlite: Database.Database;
  let scheduler: ReminderScheduler;
  let config: OwlConfig;
  let conversationStore: ConversationStore;
  let previewStore: PreviewStore;
  // Tests reassign this; the route reads it on every request.
  let nextLlm: LlmClient | null;

  before(async () => {
    const created = createDatabase({ dbPath: ':memory:' });
    db = created.db;
    sqlite = created.sqlite;
    ensureSpecialNotes(db);
    const deviceId = ensureDeviceId(db);

    const logger = createConsoleLogger('ai-route-test', 'silent');
    config = structuredClone(DEFAULT_CONFIG);
    // Provide minimal LLM config so the route doesn't 400 on missing creds.
    config.llm = {
      url: 'http://example.invalid/v1',
      model: 'mock',
      api_key: 'sk-test',
      api_format: 'openai',
      thinking_round_trip: true,
    };
    scheduler = new ReminderScheduler(db, sqlite, config, logger);
    conversationStore = new ConversationStore(sqlite);
    previewStore = new PreviewStore();

    app = buildTestServer({
      db,
      sqlite,
      config,
      logger,
      deviceId,
      scheduler,
      toolRegistry: createBuiltinRegistry(),
      conversationStore,
      previewStore,
      eventsBus: new EventsBus(),
      skybridgeSession: null,
      llmClientFactory: (_cfg: LlmConfig): LlmClient => {
        if (!nextLlm) throw new Error('test forgot to set nextLlm');
        const client = nextLlm;
        nextLlm = null;
        return client;
      },
    });
    await app.ready();
  });

  after(async () => {
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  // ── GET /ai/capabilities ──

  it('GET /ai/capabilities returns the registered tool list', async () => {
    const res = await app.inject({ method: 'GET', url: '/ai/capabilities' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    const names = body.data.tools.map((t: { name: string }) => t.name);
    assert.ok(names.includes('search_notes'));
    assert.ok(names.includes('append_memo'));
  });

  // ── POST /ai/chat — validation errors before SSE ──

  it('POST /ai/chat 400s on empty message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: { message: '   ' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().success, false);
  });

  it('POST /ai/chat 400s when LLM is not configured', async () => {
    const original = config.llm;
    config.llm = {
      url: '',
      model: '',
      api_key: '',
      api_format: 'openai',
      thinking_round_trip: true,
    };
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/ai/chat',
        payload: { message: 'hi' },
      });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().message, /LLM not configured/);
    } finally {
      config.llm = original;
    }
  });

  // ── POST /ai/chat — happy path streams events ──

  it('POST /ai/chat streams conversation_id, message, done', async () => {
    nextLlm = new QueuedLlmClient([
      [
        { type: 'text_delta', text: 'Hello!' },
        { type: 'done', stop_reason: 'end_turn' },
      ],
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: { message: 'hi there' },
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /text\/event-stream/);
    const events = parseSseEvents(res.payload);
    const types = events.map((e) => e.event);
    assert.deepEqual(types, ['conversation_id', 'message', 'done']);

    const messageEvent = events.find((e) => e.event === 'message');
    assert.ok(messageEvent);
    assert.equal((messageEvent.data as { content: string }).content, 'Hello!');

    // Conversation now exists in the store and contains the user message.
    const convId = (events[0].data as { conversation_id: string }).conversation_id;
    assert.ok(conversationStore.get(convId));
  });

  // ── POST /ai/chat — tool round-trip ──

  it('POST /ai/chat surfaces note_applied for Tier-1 writes', async () => {
    nextLlm = new QueuedLlmClient([
      [
        { type: 'tool_call_start', id: 'call_a', name: 'append_memo' },
        { type: 'tool_call_delta', id: 'call_a', arguments: '{"text":"sse-test"}' },
        { type: 'tool_call_end', id: 'call_a' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'noted.' },
        { type: 'done', stop_reason: 'end_turn' },
      ],
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: { message: 'note: sse-test' },
    });
    assert.equal(res.statusCode, 200);
    const events = parseSseEvents(res.payload);
    const order = events.map((e) => e.event);
    const idxApplied = order.indexOf('note_applied');
    const idxResult = order.indexOf('tool_result');
    assert.ok(idxApplied >= 0, 'expected note_applied event');
    assert.ok(idxApplied < idxResult, 'note_applied must precede tool_result');
  });

  // ── DELETE /ai/conversations/:id ──

  it('DELETE /ai/conversations/:id removes a conversation', async () => {
    nextLlm = new QueuedLlmClient([
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'done', stop_reason: 'end_turn' },
      ],
    ]);
    const create = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: { message: 'hi' },
    });
    const events = parseSseEvents(create.payload);
    const convId = (events[0].data as { conversation_id: string }).conversation_id;

    const del = await app.inject({ method: 'DELETE', url: `/ai/conversations/${convId}` });
    assert.equal(del.statusCode, 200);
    assert.equal(conversationStore.get(convId), undefined);

    const missing = await app.inject({
      method: 'DELETE',
      url: '/ai/conversations/no-such-id',
    });
    assert.equal(missing.statusCode, 404);
  });

  // ── GET /ai/conversations ──

  it('GET /ai/conversations returns list with title + timestamps (updated_at DESC)', async () => {
    nextLlm = new QueuedLlmClient([
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'done', stop_reason: 'end_turn' },
      ],
    ]);
    const create = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: { message: 'hello sidebar' },
    });
    const events = parseSseEvents(create.payload);
    const convId = (events[0].data as { conversation_id: string }).conversation_id;

    const list = await app.inject({ method: 'GET', url: '/ai/conversations' });
    assert.equal(list.statusCode, 200);
    const body = list.json() as {
      data: {
        conversations: { id: string; title: string; created_at: string; updated_at: string }[];
      };
    };
    const found = body.data.conversations.find((c) => c.id === convId);
    assert.ok(found, 'conversation must appear in list');
    assert.equal(found.title, 'hello sidebar');
    assert.ok(found.created_at);
    assert.ok(found.updated_at);
  });

  // ── GET /ai/conversations/:id ──

  it('GET /ai/conversations/:id returns messages, filters system + reasoning_signature', async () => {
    nextLlm = new QueuedLlmClient([
      [
        { type: 'thinking_delta', text: 'thoughts' },
        { type: 'thinking_signature', signature: 'anthropic-opaque-sig' },
        { type: 'text_delta', text: 'answer' },
        { type: 'done', stop_reason: 'end_turn' },
      ],
    ]);
    const create = await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: { message: 'please think' },
    });
    const convId = (parseSseEvents(create.payload)[0].data as { conversation_id: string })
      .conversation_id;

    const get = await app.inject({ method: 'GET', url: `/ai/conversations/${convId}` });
    assert.equal(get.statusCode, 200);
    const body = get.json() as {
      data: {
        id: string;
        title: string;
        messages: Array<{
          role: string;
          content: string;
          reasoning_content?: string;
          reasoning_signature?: string;
        }>;
      };
    };
    assert.equal(body.data.id, convId);
    // No system role in the shipped payload (prompt engineering is private).
    assert.ok(!body.data.messages.some((m) => m.role === 'system'));
    // Reasoning_content is surfaced for GUI hydration (→ ChatMessage.thinking).
    const assistant = body.data.messages.find((m) => m.role === 'assistant');
    assert.ok(assistant);
    assert.equal(assistant.reasoning_content, 'thoughts');
    // But reasoning_signature (Anthropic-only opaque blob) is stripped.
    assert.equal(assistant.reasoning_signature, undefined);
  });

  it('GET /ai/conversations/:id returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ai/conversations/no-such-id',
    });
    assert.equal(res.statusCode, 404);
  });

  // ── POST /ai/preview/apply ──

  it('POST /ai/preview/apply commits a stored external preview', async () => {
    const stored = previewStore.create({
      action: 'create',
      content: 'apply via http',
      tags: ['#http-preview'],
      folder_id: null,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/ai/preview/apply',
      payload: { preview_id: stored.id },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.action, 'create');
    assert.ok(body.data.note_id);
    // Preview consumed.
    assert.equal(previewStore.get(stored.id), undefined);

    // 404 on second apply.
    const again = await app.inject({
      method: 'POST',
      url: '/ai/preview/apply',
      payload: { preview_id: stored.id },
    });
    assert.equal(again.statusCode, 404);
  });

  it('POST /ai/preview/apply 400s on missing preview_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ai/preview/apply',
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('GET /ai/conversations lists active conversations', async () => {
    nextLlm = new QueuedLlmClient([
      [
        { type: 'text_delta', text: 'x' },
        { type: 'done', stop_reason: 'end_turn' },
      ],
    ]);
    await app.inject({
      method: 'POST',
      url: '/ai/chat',
      payload: { message: 'list-me' },
    });
    const res = await app.inject({ method: 'GET', url: '/ai/conversations' });
    assert.equal(res.statusCode, 200);
    const list = res.json().data.conversations as Array<{ id: string; message_count: number }>;
    assert.ok(list.length >= 1);
    assert.ok(list[0].message_count > 0);
  });
});
