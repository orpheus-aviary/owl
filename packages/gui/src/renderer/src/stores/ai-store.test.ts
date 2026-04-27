import * as api from '@/lib/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiStore } from './ai-store';
import type { ChatMessage, ChatTabState, DraftReadyCard } from './ai-store-types';

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

const CHAT_ID = 'chat-1';
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
  const tab: ChatTabState = {
    id: CHAT_ID,
    conversationId: 'conv-1',
    title: 't',
    messages: [message],
    abortController: null,
    isStreaming: false,
  };
  useAiStore.setState({ chats: [tab], activeChatId: CHAT_ID, noteAppliedNotices: [] });
}

function getDraft(localId: string): DraftReadyCard | undefined {
  return useAiStore.getState().chats[0].messages[0].drafts.find((d) => d.localId === localId);
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

    await useAiStore.getState().approveDraft(CHAT_ID, MSG_ID, 'd-1');

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy.mock.calls[0][0]).toBe('note-1');
    const draft = getDraft('d-1');
    expect(draft?.approved).toBe(true);
    expect(draft?.approving).toBe(false);
    expect(draft?.error).toBe(null);
    expect(useAiStore.getState().noteAppliedNotices).toHaveLength(1);
  });

  it('refuses to overwrite when the DB content drifted from the AI baseline', async () => {
    // DB now has different content than the AI's `original_content` snapshot —
    // approving would silently clobber the user's external edit. Refuse.
    vi.spyOn(api, 'getNote').mockResolvedValue({
      success: true,
      data: { id: 'note-1', content: 'externally edited body' } as never,
    });
    const patchSpy = vi.spyOn(api, 'patchNote');

    await useAiStore.getState().approveDraft(CHAT_ID, MSG_ID, 'd-1');

    expect(patchSpy).not.toHaveBeenCalled();
    const draft = getDraft('d-1');
    expect(draft?.approved).toBe(false);
    expect(draft?.error).toMatch(/已被外部修改/);
    // Toast queue stays empty when approval was refused.
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

    await useAiStore.getState().approveAllDrafts(CHAT_ID, MSG_ID);

    // a + c approved, b held back with error.
    expect(getDraft('d-a')?.approved).toBe(true);
    expect(getDraft('d-c')?.approved).toBe(true);
    expect(getDraft('d-b')?.approved).toBe(false);
    expect(getDraft('d-b')?.error).toMatch(/已被外部修改/);
    // Patch only fired for the two non-conflicting drafts.
    expect(patchSpy).toHaveBeenCalledTimes(2);
    // Two toasts fired (one per success).
    expect(useAiStore.getState().noteAppliedNotices).toHaveLength(2);
  });

  it('skips already-approved or in-flight cards on retry', async () => {
    seedStore([draftCard({ approved: true })]);
    const patchSpy = vi.spyOn(api, 'patchNote');
    await useAiStore.getState().approveDraft(CHAT_ID, MSG_ID, 'd-1');
    expect(patchSpy).not.toHaveBeenCalled();
  });
});
