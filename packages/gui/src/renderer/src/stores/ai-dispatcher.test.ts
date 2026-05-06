import { describe, expect, it } from 'vitest';
import { type DispatcherState, dispatchAgentEvent } from './ai-dispatcher';
import type { ChatMessage } from './ai-store-types';

/**
 * Build a minimal dispatcher state with one streaming assistant message
 * ready to receive deltas. Each test starts from a fresh copy so
 * mutations from one case don't leak into the next.
 *
 * P3.4-f: the dispatcher now owns a messages[] array directly (not
 * nested inside ChatTabState). Conversation routing lives in the store.
 */
function baseState(): { state: DispatcherState; assistantMessageId: string } {
  const assistantMessageId = 'msg-assistant';
  const userMsg: ChatMessage = {
    id: 'msg-user',
    role: 'user',
    content: 'hi',
    thinking: '',
    toolCalls: [],
    drafts: [],
    previews: [],
    isStreaming: false,
  };
  const assistantMsg: ChatMessage = {
    id: assistantMessageId,
    role: 'assistant',
    content: '',
    thinking: '',
    toolCalls: [],
    drafts: [],
    previews: [],
    isStreaming: true,
  };
  return {
    state: { messages: [userMsg, assistantMsg], noteAppliedNotices: [] },
    assistantMessageId,
  };
}

let counter = 0;
const newLocalId = () => `id-${++counter}`;

function activeMessage(state: DispatcherState, messageId: string): ChatMessage {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) throw new Error('assistant message missing');
  return msg;
}

describe('dispatchAgentEvent', () => {
  it('conversation_id is a no-op (store owns the id)', () => {
    const { state, assistantMessageId } = baseState();
    const next = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'conversation_id',
      data: { conversation_id: 'conv-abc' },
      newLocalId,
    });
    // P3.4-f collapsed local+server id; the dispatcher no longer patches
    // anything on conversation_id — state should be referentially unchanged.
    expect(next).toBe(state);
  });

  it('thinking appends to the assistant message thinking buffer', () => {
    const { state, assistantMessageId } = baseState();
    const after1 = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'thinking',
      data: { content: 'Considering ' },
      newLocalId,
    });
    const after2 = dispatchAgentEvent({
      state: after1,
      assistantMessageId,
      event: 'thinking',
      data: { content: 'options…' },
      newLocalId,
    });
    expect(activeMessage(after2, assistantMessageId).thinking).toBe('Considering options…');
    expect(activeMessage(after2, assistantMessageId).content).toBe('');
  });

  it('message appends content to the streaming assistant message', () => {
    const { state, assistantMessageId } = baseState();
    const after1 = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'message',
      data: { content: 'Hello ' },
      newLocalId,
    });
    const after2 = dispatchAgentEvent({
      state: after1,
      assistantMessageId,
      event: 'message',
      data: { content: 'world' },
      newLocalId,
    });
    expect(activeMessage(after2, assistantMessageId).content).toBe('Hello world');
  });

  it('tool_call pushes a ChatToolCall onto the assistant message', () => {
    const { state, assistantMessageId } = baseState();
    const next = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'tool_call',
      data: { tool_call_id: 't1', tool: 'search_notes', args: { query: 'foo' } },
      newLocalId,
    });
    expect(activeMessage(next, assistantMessageId).toolCalls).toEqual([
      { id: 't1', name: 'search_notes', args: { query: 'foo' } },
    ]);
  });

  it('tool_result patches the matching tool call', () => {
    const { state, assistantMessageId } = baseState();
    const withCall = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'tool_call',
      data: { tool_call_id: 't1', tool: 'list_tags', args: {} },
      newLocalId,
    });
    const withResult = dispatchAgentEvent({
      state: withCall,
      assistantMessageId,
      event: 'tool_result',
      data: { tool_call_id: 't1', tool: 'list_tags', result: { tags: [] }, is_error: false },
      newLocalId,
    });
    const tc = activeMessage(withResult, assistantMessageId).toolCalls[0];
    expect(tc.result).toEqual({ tags: [] });
    expect(tc.isError).toBe(false);
  });

  it('tool_result flags is_error=true', () => {
    const { state, assistantMessageId } = baseState();
    const withCall = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'tool_call',
      data: { tool_call_id: 'tx', tool: 'whatever', args: {} },
      newLocalId,
    });
    const withResult = dispatchAgentEvent({
      state: withCall,
      assistantMessageId,
      event: 'tool_result',
      data: { tool_call_id: 'tx', tool: 'whatever', result: { error: 'boom' }, is_error: true },
      newLocalId,
    });
    expect(activeMessage(withResult, assistantMessageId).toolCalls[0].isError).toBe(true);
  });

  it('note_applied pushes a notice and leaves assistant message untouched', () => {
    const { state, assistantMessageId } = baseState();
    const next = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'note_applied',
      data: { note_id: 'memo', appended_text: 'milk', content: 'memo body\n\nmilk' },
      newLocalId,
    });
    expect(next.noteAppliedNotices).toHaveLength(1);
    expect(next.noteAppliedNotices[0]).toMatchObject({
      noteId: 'memo',
      appendedText: 'milk',
      latestContent: 'memo body\n\nmilk',
    });
    expect(activeMessage(next, assistantMessageId).content).toBe('');
  });

  it('draft_ready pushes a DraftReadyCard with original_* baselines', () => {
    const { state, assistantMessageId } = baseState();
    const next = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'draft_ready',
      data: {
        action: 'update',
        note_id: 'note-9',
        content: 'new body',
        tags: ['#x'],
        folder_id: null,
        original_content: 'old body',
        original_tags: ['#y'],
        original_folder_id: null,
      },
      newLocalId,
    });
    const drafts = activeMessage(next, assistantMessageId).drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: 'update',
      note_id: 'note-9',
      content: 'new body',
      tags: ['#x'],
      original_content: 'old body',
      original_tags: ['#y'],
      opened: false,
    });
  });

  it('draft_ready ignores unknown action values', () => {
    const { state, assistantMessageId } = baseState();
    const next = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'draft_ready',
      data: { action: 'mystery', note_id: 'n', content: '', tags: [], folder_id: null },
      newLocalId,
    });
    expect(activeMessage(next, assistantMessageId).drafts).toEqual([]);
  });

  it('preview_ready pushes a PreviewReadyCard', () => {
    const { state, assistantMessageId } = baseState();
    const next = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'preview_ready',
      data: {
        preview_id: 'preview_1',
        action: 'create',
        diff: '## content\nbefore\nafter',
        content: 'after',
        tags: ['#new'],
        folder_id: null,
      },
      newLocalId,
    });
    const previews = activeMessage(next, assistantMessageId).previews;
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      preview_id: 'preview_1',
      action: 'create',
      diff: '## content\nbefore\nafter',
    });
  });

  it('error sets message.error and clears its streaming flag', () => {
    const { state, assistantMessageId } = baseState();
    const next = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'error',
      data: { message: 'LLM exploded' },
      newLocalId,
    });
    const msg = activeMessage(next, assistantMessageId);
    expect(msg.error).toBe('LLM exploded');
    expect(msg.isStreaming).toBe(false);
  });

  it('done flips assistant message isStreaming false', () => {
    const { state, assistantMessageId } = baseState();
    const next = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'done',
      data: { conversation_id: 'c', stop_reason: 'end_turn' },
      newLocalId,
    });
    expect(activeMessage(next, assistantMessageId).isStreaming).toBe(false);
  });

  it('unknown events leave state unchanged', () => {
    const { state, assistantMessageId } = baseState();
    const next = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'mystery_event_from_the_future',
      data: { x: 1 },
      newLocalId,
    });
    expect(next).toBe(state);
  });

  it('malformed events fail closed (no crash, no mutation)', () => {
    const { state, assistantMessageId } = baseState();
    const next = dispatchAgentEvent({
      state,
      assistantMessageId,
      event: 'tool_call',
      data: { tool: 'no_id' },
      newLocalId,
    });
    expect(activeMessage(next, assistantMessageId).toolCalls).toEqual([]);
  });
});

describe('end-to-end ordering', () => {
  it('replays a realistic Tier-1 turn into the right places', () => {
    const { state, assistantMessageId } = baseState();
    const events: Array<[string, unknown]> = [
      ['conversation_id', { conversation_id: 'conv-1' }],
      ['tool_call', { tool_call_id: 't1', tool: 'append_memo', args: { text: 'milk' } }],
      ['note_applied', { note_id: 'memo', appended_text: 'milk', content: 'memo body\n\nmilk' }],
      [
        'tool_result',
        { tool_call_id: 't1', tool: 'append_memo', result: { message: 'ok' }, is_error: false },
      ],
      ['message', { content: 'Done.' }],
      ['done', { conversation_id: 'conv-1', stop_reason: 'end_turn' }],
    ];
    let cur = state;
    for (const [event, data] of events) {
      cur = dispatchAgentEvent({ state: cur, assistantMessageId, event, data, newLocalId });
    }
    expect(cur.noteAppliedNotices).toHaveLength(1);
    const msg = activeMessage(cur, assistantMessageId);
    expect(msg.content).toBe('Done.');
    expect(msg.isStreaming).toBe(false);
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls[0].result).toEqual({ message: 'ok' });
  });
});
