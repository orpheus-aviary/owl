import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  DEFAULT_CONFIG,
  type OwlConfig,
  type OwlDatabase,
  SPECIAL_NOTES,
  createConsoleLogger,
  createDatabase,
  createNote,
  ensureDeviceId,
  ensureSpecialNotes,
  getNote,
} from '@owl/core';
import type Database from 'better-sqlite3';
import { ReminderScheduler } from '../scheduler.js';
import { type AgentEvent, runAgentLoop } from './agent-loop.js';
import { ConversationStore } from './conversations.js';
import type { ChatOptions, LlmClient, LlmMessage, LlmToolDef, StreamChunk } from './llm-client.js';
import { PreviewStore } from './preview-store.js';
import { createBuiltinRegistry } from './tools/index.js';

// ─── Mock LLM ──────────────────────────────────────────────────────────

/**
 * Replays a queued list of stream-chunk arrays (one array per LLM call).
 * Each call shifts the next array off the queue so a multi-turn agent
 * loop can be scripted explicitly.
 */
class MockLlmClient implements LlmClient {
  readonly seenMessages: LlmMessage[][] = [];
  constructor(private readonly chunkQueue: StreamChunk[][]) {}

  async *chatCompletion(
    messages: LlmMessage[],
    _tools: LlmToolDef[],
    _options?: ChatOptions,
  ): AsyncIterable<StreamChunk> {
    this.seenMessages.push(structuredClone(messages));
    const next = this.chunkQueue.shift();
    if (!next) throw new Error('MockLlmClient: chunk queue exhausted');
    for (const chunk of next) yield chunk;
  }
}

async function collect(generator: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of generator) out.push(ev);
  return out;
}

// ─── Fixtures ──────────────────────────────────────────────────────────

describe('agent loop (P2-7c)', () => {
  let db: OwlDatabase;
  let sqlite: Database.Database;
  let scheduler: ReminderScheduler;
  let config: OwlConfig;
  let deviceId: string;
  let logger: ReturnType<typeof createConsoleLogger>;

  before(() => {
    const created = createDatabase({ dbPath: ':memory:' });
    db = created.db;
    sqlite = created.sqlite;
    ensureSpecialNotes(db);
    deviceId = ensureDeviceId(db);
    config = structuredClone(DEFAULT_CONFIG);
    logger = createConsoleLogger('agent-test', 'silent');
    scheduler = new ReminderScheduler(db, sqlite, config, logger);

    createNote(db, sqlite, {
      content: '# Recent fixture\n\nbody',
      tags: [{ tagType: '#', tagValue: 'fixture' }],
    });
  });

  after(() => {
    scheduler.stop();
    sqlite.close();
  });

  function buildDeps(llm: LlmClient) {
    const registry = createBuiltinRegistry();
    const conversations = new ConversationStore();
    return {
      llmClient: llm,
      registry,
      conversations,
      db,
      sqlite,
      config,
      toolCtx: {
        db,
        sqlite,
        config,
        deviceId,
        scheduler,
        source: 'gui' as const,
        logger,
        previewStore: new PreviewStore(),
      },
    };
  }

  // ── Plain text response ──

  it('streams a plain assistant message and emits done', async () => {
    const llm = new MockLlmClient([
      [
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ' world' },
        { type: 'done', stop_reason: 'end_turn' },
      ],
    ]);
    const events = await collect(runAgentLoop({ message: 'hi' }, buildDeps(llm)));
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ['conversation_id', 'message', 'done']);
    const msg = events.find((e) => e.type === 'message');
    assert.equal(msg && msg.type === 'message' ? msg.content : '', 'Hello world');

    // System prompt + user message should reach the LLM.
    assert.equal(llm.seenMessages.length, 1);
    const first = llm.seenMessages[0];
    assert.equal(first[0].role, 'system');
    assert.ok(first[0].content.toString().includes('Recent fixture'));
    assert.equal(first.at(-1)?.role, 'user');
  });

  // ── Tool call → tool result → second LLM turn ──

  it('executes a read tool and feeds the result back', async () => {
    const llm = new MockLlmClient([
      [
        { type: 'tool_call_start', id: 'call_1', name: 'list_tags' },
        { type: 'tool_call_delta', id: 'call_1', arguments: '{}' },
        { type: 'tool_call_end', id: 'call_1' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'Done.' },
        { type: 'done', stop_reason: 'end_turn' },
      ],
    ]);

    const events = await collect(runAgentLoop({ message: 'what tags?' }, buildDeps(llm)));
    const types = events.map((e) => e.type);
    assert.deepEqual(types, ['conversation_id', 'tool_call', 'tool_result', 'message', 'done']);

    // Second LLM call should include the tool result message.
    assert.equal(llm.seenMessages.length, 2);
    const second = llm.seenMessages[1];
    const toolResult = second.find((m) => m.role === 'tool');
    assert.ok(toolResult, 'expected tool result in second turn messages');
    assert.equal(toolResult.tool_call_id, 'call_1');
  });

  // ── Tier-1 write surfaces note_applied BEFORE tool_result ──

  it('emits note_applied before tool_result for Tier-1 writes', async () => {
    const llm = new MockLlmClient([
      [
        { type: 'tool_call_start', id: 'call_2', name: 'append_memo' },
        { type: 'tool_call_delta', id: 'call_2', arguments: '{"text":"buy milk"}' },
        { type: 'tool_call_end', id: 'call_2' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'Added.' },
        { type: 'done', stop_reason: 'end_turn' },
      ],
    ]);

    const events = await collect(runAgentLoop({ message: 'remember buy milk' }, buildDeps(llm)));
    const idx = (t: AgentEvent['type']) => events.findIndex((e) => e.type === t);
    assert.ok(idx('note_applied') >= 0, 'expected note_applied event');
    assert.ok(idx('note_applied') < idx('tool_result'), 'note_applied must precede tool_result');

    const ev = events.find((e) => e.type === 'note_applied');
    assert.ok(ev && ev.type === 'note_applied');
    assert.equal(ev.note_id, SPECIAL_NOTES.MEMO);
    assert.equal(ev.appended_text, 'buy milk');
    // DB write actually happened.
    const memo = getNote(db, SPECIAL_NOTES.MEMO);
    assert.ok(memo?.content.includes('buy milk'));
  });

  // ── Unknown tool → error result, loop continues ──

  it('returns an error result for unknown tools without crashing', async () => {
    const llm = new MockLlmClient([
      [
        { type: 'tool_call_start', id: 'call_3', name: 'no_such_tool' },
        { type: 'tool_call_delta', id: 'call_3', arguments: '{}' },
        { type: 'tool_call_end', id: 'call_3' },
        { type: 'done', stop_reason: 'tool_use' },
      ],
      [{ type: 'done', stop_reason: 'end_turn' }],
    ]);
    const events = await collect(runAgentLoop({ message: '?' }, buildDeps(llm)));
    const result = events.find((e) => e.type === 'tool_result');
    assert.ok(result && result.type === 'tool_result');
    assert.equal(result.is_error, true);
  });

  // ── Iteration cap ──

  it('stops with stop_reason=max_iterations when LLM keeps calling tools', async () => {
    // Queue 4 identical tool_call rounds; cap at 3.
    const round = (id: string): StreamChunk[] => [
      { type: 'tool_call_start', id, name: 'list_tags' },
      { type: 'tool_call_delta', id, arguments: '{}' },
      { type: 'tool_call_end', id },
      { type: 'done', stop_reason: 'tool_use' },
    ];
    const llm = new MockLlmClient([round('a'), round('b'), round('c'), round('d')]);
    const events = await collect(runAgentLoop({ message: 'go', maxIterations: 3 }, buildDeps(llm)));
    const done = events.at(-1);
    assert.ok(done && done.type === 'done');
    assert.equal(done.stop_reason, 'max_iterations');
  });

  // ── Conversation persistence + reuse ──

  it('reuses an existing conversation and refreshes the system prompt', async () => {
    const deps = buildDeps(
      new MockLlmClient([
        [
          { type: 'text_delta', text: 'first' },
          { type: 'done', stop_reason: 'end_turn' },
        ],
      ]),
    );
    const events = await collect(runAgentLoop({ message: 'one' }, deps));
    const idEvent = events.find((e) => e.type === 'conversation_id');
    const conversationId =
      idEvent && idEvent.type === 'conversation_id' ? idEvent.conversation_id : '';
    assert.ok(conversationId);

    const llm2 = new MockLlmClient([
      [
        { type: 'text_delta', text: 'second' },
        { type: 'done', stop_reason: 'end_turn' },
      ],
    ]);
    const deps2 = { ...deps, llmClient: llm2 };
    await collect(runAgentLoop({ message: 'two', conversationId }, deps2));

    // Same conversation id was reused, second turn sees both user messages.
    const conv = deps.conversations.get(conversationId);
    assert.ok(conv);
    const userMessages = conv.messages.filter((m) => m.role === 'user');
    assert.equal(userMessages.length, 2);
    // System message stays at index 0 and only appears once.
    assert.equal(conv.messages[0].role, 'system');
    assert.equal(conv.messages.filter((m) => m.role === 'system').length, 1);
  });
});

// ─── ConversationStore ─────────────────────────────────────────────────

describe('ConversationStore', () => {
  it('generates a new id when none provided', () => {
    const store = new ConversationStore();
    const a = store.getOrCreate();
    const b = store.getOrCreate();
    assert.notEqual(a.conversation.id, b.conversation.id);
    assert.equal(a.created, true);
  });

  it('returns existing conversation when id matches', () => {
    const store = new ConversationStore();
    const { conversation } = store.getOrCreate('fixed-id');
    const again = store.getOrCreate('fixed-id');
    assert.equal(again.created, false);
    assert.strictEqual(again.conversation, conversation);
  });

  it('trimToRounds keeps system + last N user turns with their tool round-trips', () => {
    const store = new ConversationStore();
    const { conversation } = store.getOrCreate('c1');
    conversation.messages.push(
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', name: 'x', arguments: '{}' }],
      },
      { role: 'tool', tool_call_id: 't1', content: 'r1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
      { role: 'assistant', content: 'a3' },
    );

    store.trimToRounds('c1', 2);
    const trimmed = store.get('c1');
    assert.ok(trimmed);
    assert.equal(trimmed.messages[0].role, 'system');
    // First user-turn (u1 with its tool round-trip) should be dropped.
    const userMessages = trimmed.messages.filter((m) => m.role === 'user');
    assert.deepEqual(
      userMessages.map((m) => m.content),
      ['u2', 'u3'],
    );
    // Tool result from the dropped round must be gone too.
    assert.equal(
      trimmed.messages.some((m) => m.role === 'tool'),
      false,
    );
  });

  it('trimToRounds is a no-op when under the round cap', () => {
    const store = new ConversationStore();
    const { conversation } = store.getOrCreate('c2');
    conversation.messages.push(
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    );
    store.trimToRounds('c2', 5);
    const stored = store.get('c2');
    assert.equal(stored?.messages.length, 3);
  });
});
