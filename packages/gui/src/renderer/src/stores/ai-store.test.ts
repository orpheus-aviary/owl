import * as api from '@/lib/api';
import type { AiHistoryMessage } from '@/lib/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateDaemonMessages, useAiStore } from './ai-store';
import type { ChatMessage, DraftReadyCard } from './ai-store-types';

// Stub window + fetch the same way editor-store.test does — store reads
// hit `window.owlAPI?.daemonUrl` and fetch under the hood; we mock the
// REST APIs directly via vi.spyOn instead of stubbing fetch.
(globalThis as unknown as { window: { owlAPI?: unknown } }).window = { owlAPI: undefined };
vi.stubGlobal(
  'fetch',
  vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ success: true, data: { items: [], total: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ),
);

const CONV_ID = 'conv-1';
const MSG_ID = 'msg-1';

function draftCard(overrides: Partial<DraftReadyCard> = {}): DraftReadyCard {
  return {
    localId: overrides.localId ?? 'd-1',
    action: 'update',
    note_id: 'note-1',
    content: 'new content',
    tags: ['#a'],
    folder_id: null,
    original_content: 'old content',
    original_tags: ['#a'],
    original_folder_id: null,
    opened: false,
    approved: false,
    approving: false,
    error: null,
    ...overrides,
  };
}

function seedStore(drafts: DraftReadyCard[]): void {
  const message: ChatMessage = {
    id: MSG_ID,
    role: 'assistant',
    content: '',
    thinking: '',
    toolCalls: [],
    drafts,
    previews: [],
    isStreaming: false,
  };
  useAiStore.setState({
    conversations: [
      {
        id: CONV_ID,
        title: 't',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 1,
      },
    ],
    conversationsLoaded: true,
    messagesByConversation: { [CONV_ID]: [message] },
    streamingByConversation: {},
    activeConversationId: CONV_ID,
    noteAppliedNotices: [],
    scrollByConversation: {},
  });
}

function getDraft(localId: string): DraftReadyCard | undefined {
  return useAiStore
    .getState()
    .messagesByConversation[CONV_ID]?.[0].drafts.find((d) => d.localId === localId);
}

describe('approveDraft (P3.0.5 #2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    seedStore([draftCard()]);
  });

  it('writes via PATCH for update drafts and pushes a Tier-1 toast', async () => {
    vi.spyOn(api, 'getNote').mockResolvedValue({
      success: true,
      data: { id: 'note-1', content: 'old content' } as never,
    });
    const patchSpy = vi
      .spyOn(api, 'patchNote')
      .mockResolvedValue({ success: true, data: { id: 'note-1' } as never });

    await useAiStore.getState().approveDraft(CONV_ID, MSG_ID, 'd-1');

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy.mock.calls[0][0]).toBe('note-1');
    const draft = getDraft('d-1');
    expect(draft?.approved).toBe(true);
    expect(draft?.approving).toBe(false);
    expect(draft?.error).toBe(null);
    expect(useAiStore.getState().noteAppliedNotices).toHaveLength(1);
  });

  it('refuses to overwrite when the DB content drifted from the AI baseline', async () => {
    vi.spyOn(api, 'getNote').mockResolvedValue({
      success: true,
      data: { id: 'note-1', content: 'externally edited body' } as never,
    });
    const patchSpy = vi.spyOn(api, 'patchNote');

    await useAiStore.getState().approveDraft(CONV_ID, MSG_ID, 'd-1');

    expect(patchSpy).not.toHaveBeenCalled();
    const draft = getDraft('d-1');
    expect(draft?.approved).toBe(false);
    expect(draft?.error).toMatch(/已被外部修改/);
    expect(useAiStore.getState().noteAppliedNotices).toHaveLength(0);
  });

  it('approveAllDrafts isolates per-card failures (3 drafts, 1 fails)', async () => {
    seedStore([
      draftCard({ localId: 'd-a', note_id: 'a' }),
      draftCard({ localId: 'd-b', note_id: 'b' }),
      draftCard({ localId: 'd-c', note_id: 'c' }),
    ]);
    vi.spyOn(api, 'getNote').mockImplementation(async (id: string) => ({
      success: true,
      data: { id, content: id === 'b' ? 'drifted' : 'old content' } as never,
    }));
    const patchSpy = vi
      .spyOn(api, 'patchNote')
      .mockResolvedValue({ success: true, data: { id: 'x' } as never });

    await useAiStore.getState().approveAllDrafts(CONV_ID, MSG_ID);

    expect(getDraft('d-a')?.approved).toBe(true);
    expect(getDraft('d-c')?.approved).toBe(true);
    expect(getDraft('d-b')?.approved).toBe(false);
    expect(getDraft('d-b')?.error).toMatch(/已被外部修改/);
    expect(patchSpy).toHaveBeenCalledTimes(2);
    expect(useAiStore.getState().noteAppliedNotices).toHaveLength(2);
  });

  it('skips already-approved or in-flight cards on retry', async () => {
    seedStore([draftCard({ approved: true })]);
    const patchSpy = vi.spyOn(api, 'patchNote');
    await useAiStore.getState().approveDraft(CONV_ID, MSG_ID, 'd-1');
    expect(patchSpy).not.toHaveBeenCalled();
  });
});

// ─── P3.4-f hydration ──────────────────────────────────────────────────

describe('hydrateDaemonMessages (P3.4-f §5.5)', () => {
  it('folds LlmMessage[] into ChatMessage[] with tool_calls paired by id', () => {
    const history: AiHistoryMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [
          { id: 't1', name: 'search_notes', arguments: '{"q":"foo"}' },
          { id: 't2', name: 'list_tags', arguments: '{}' },
        ],
      },
      {
        role: 'tool',
        content: '{"matches":[]}',
        tool_call_id: 't1',
        is_error: false,
      },
      {
        role: 'tool',
        content: '{"error":"boom"}',
        tool_call_id: 't2',
        is_error: true,
      },
      { role: 'assistant', content: 'done' },
    ];
    const msgs = hydrateDaemonMessages(history);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].toolCalls).toHaveLength(2);
    expect(msgs[1].toolCalls[0]).toMatchObject({
      id: 't1',
      name: 'search_notes',
      args: { q: 'foo' },
      isError: false,
    });
    expect(msgs[1].toolCalls[0].result).toEqual({ matches: [] });
    expect(msgs[1].toolCalls[1]).toMatchObject({ id: 't2', isError: true });
    expect(msgs[1].toolCalls[1].result).toEqual({ error: 'boom' });
    expect(msgs[2]).toMatchObject({ role: 'assistant', content: 'done' });
  });

  it('hydrates reasoning_content into ChatMessage.thinking (free upgrade)', () => {
    const history: AiHistoryMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'answer',
        reasoning_content: 'I should think carefully about this.',
      },
    ];
    const msgs = hydrateDaemonMessages(history);
    expect(msgs[1].thinking).toBe('I should think carefully about this.');
    expect(msgs[1].content).toBe('answer');
  });

  it('drafts / previews hydrate as empty (transient UI artifacts)', () => {
    const history: AiHistoryMessage[] = [
      { role: 'user', content: 'add a memo' },
      { role: 'assistant', content: 'done' },
    ];
    const msgs = hydrateDaemonMessages(history);
    expect(msgs[1].drafts).toEqual([]);
    expect(msgs[1].previews).toEqual([]);
  });

  it('tool rows without a matching assistant are dropped (defensive)', () => {
    const history: AiHistoryMessage[] = [
      // No preceding assistant + tool_calls → orphan, silently skipped.
      { role: 'tool', content: '{}', tool_call_id: 'nope' },
      { role: 'user', content: 'hello' },
    ];
    const msgs = hydrateDaemonMessages(history);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
  });
});

describe('sendMessage / conversation lifecycle (P3.4-f)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAiStore.setState({
      conversations: [],
      conversationsLoaded: false,
      messagesByConversation: {},
      streamingByConversation: {},
      activeConversationId: null,
      noteAppliedNotices: [],
      scrollByConversation: {},
    });
  });

  it('newConversation creates an ephemeral entry in messagesByConversation only', () => {
    const id = useAiStore.getState().newConversation();
    const state = useAiStore.getState();
    expect(state.activeConversationId).toBe(id);
    expect(state.messagesByConversation[id]).toEqual([]);
    // Sidebar stays empty until the first send persists the conversation.
    expect(state.conversations.find((c) => c.id === id)).toBeUndefined();
  });

  it('setActiveConversation does not abort other conversations streams', () => {
    const abortA = new AbortController();
    const abortB = new AbortController();
    useAiStore.setState({
      streamingByConversation: {
        a: { isStreaming: true, abortController: abortA, assistantMessageId: 'mA' },
        b: { isStreaming: true, abortController: abortB, assistantMessageId: 'mB' },
      },
      activeConversationId: 'a',
    });
    const abortedA = vi.fn();
    const abortedB = vi.fn();
    abortA.signal.addEventListener('abort', abortedA);
    abortB.signal.addEventListener('abort', abortedB);

    useAiStore.getState().setActiveConversation('b');

    expect(useAiStore.getState().activeConversationId).toBe('b');
    // Neither stream should have been aborted — background streaming is preserved.
    expect(abortedA).not.toHaveBeenCalled();
    expect(abortedB).not.toHaveBeenCalled();
  });

  it('deleteConversation on ephemeral (no DB row) only clears local state', async () => {
    const id = useAiStore.getState().newConversation();
    const apiSpy = vi.spyOn(api, 'deleteAiConversation');

    await useAiStore.getState().deleteConversation(id);

    expect(apiSpy).not.toHaveBeenCalled();
    const state = useAiStore.getState();
    expect(state.messagesByConversation[id]).toBeUndefined();
    expect(state.activeConversationId).toBeNull();
  });

  it('deleteConversation on persisted id calls the daemon and clears local state', async () => {
    const id = 'persisted-x';
    useAiStore.setState({
      conversations: [{ id, title: 'x', createdAt: 0, updatedAt: 0, messageCount: 1 }],
      messagesByConversation: { [id]: [] },
      activeConversationId: id,
    });
    const apiSpy = vi
      .spyOn(api, 'deleteAiConversation')
      .mockResolvedValue({ success: true, data: { id } });
    // Also stub listAiConversations since refresh may fire elsewhere.
    vi.spyOn(api, 'listAiConversations').mockResolvedValue({
      success: true,
      data: { conversations: [] },
    });

    await useAiStore.getState().deleteConversation(id);

    expect(apiSpy).toHaveBeenCalledWith(id);
    const state = useAiStore.getState();
    expect(state.conversations.find((c) => c.id === id)).toBeUndefined();
    expect(state.messagesByConversation[id]).toBeUndefined();
    expect(state.activeConversationId).toBeNull();
  });

  it('loadConversations populates conversations + conversationsLoaded', async () => {
    vi.spyOn(api, 'listAiConversations').mockResolvedValue({
      success: true,
      data: {
        conversations: [
          {
            id: 'a',
            title: 'alpha',
            created_at: '2026-05-07T00:00:00Z',
            updated_at: '2026-05-07T01:00:00Z',
            message_count: 4,
          },
        ],
      },
    });

    await useAiStore.getState().loadConversations();

    const state = useAiStore.getState();
    expect(state.conversationsLoaded).toBe(true);
    expect(state.conversations).toHaveLength(1);
    expect(state.conversations[0]).toMatchObject({ id: 'a', title: 'alpha', messageCount: 4 });
  });

  it('loadConversation hydrates messagesByConversation on cache miss', async () => {
    vi.spyOn(api, 'getAiConversation').mockResolvedValue({
      success: true,
      data: {
        id: 'c',
        title: 't',
        created_at: '',
        updated_at: '',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'ok', reasoning_content: 'thinking' },
        ],
      },
    });

    await useAiStore.getState().loadConversation('c');

    const msgs = useAiStore.getState().messagesByConversation.c;
    expect(msgs).toBeDefined();
    expect(msgs).toHaveLength(2);
    expect(msgs?.[1].thinking).toBe('thinking');
  });

  it('loadConversation skips refetch when messages are already cached', async () => {
    const existing: ChatMessage = {
      id: 'x',
      role: 'user',
      content: 'existing',
      thinking: '',
      toolCalls: [],
      drafts: [],
      previews: [],
      isStreaming: false,
    };
    useAiStore.setState({ messagesByConversation: { c: [existing] } });
    const apiSpy = vi.spyOn(api, 'getAiConversation');

    await useAiStore.getState().loadConversation('c');

    expect(apiSpy).not.toHaveBeenCalled();
  });
});
