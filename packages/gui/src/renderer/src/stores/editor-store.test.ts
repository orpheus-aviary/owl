import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from './editor-store';
import type { PendingAiUpdate } from './editor-store';

// saveNote fires `useNoteStore.getState().fetchNotes()` fire-and-forget.
// fetchNotes → api.request → `window.owlAPI?.daemonUrl`. In Node there's
// no `window`. Stub it to a minimal shape so the side fetch resolves to
// a fake-rejected promise without throwing a `ReferenceError` we can't
// catch from here.
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

/**
 * Coverage for P2-8 step 6 — `applyNoteAppliedFromAi`:
 *   1. no open tab → no-op
 *   2. open + clean → silent overwrite, baselines reset
 *   3. open + dirty → auto-merge append, originalContent = DB
 *   4. dirty + 2nd apply → both appends land
 *
 * The action is pure state — no network calls — so we drive the zustand
 * store directly and snapshot `tabs` after each call.
 */

function makeNote(id: string, content: string): Note {
  return {
    id,
    content,
    tags: [],
    folderId: null,
    trashLevel: 0,
    createdAt: '',
    updatedAt: '',
    trashedAt: null,
    autoDeleteAt: null,
    deviceId: null,
    contentHash: null,
  };
}

function getTab(noteId: string) {
  return useEditorStore.getState().tabs.find((t) => t.noteId === noteId);
}

describe('applyNoteAppliedFromAi', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
  });

  it('no open tab → state is unchanged', () => {
    const before = useEditorStore.getState().tabs;
    useEditorStore.getState().applyNoteAppliedFromAi('memo', 'db', 'appended');
    expect(useEditorStore.getState().tabs).toBe(before);
  });

  it('clean tab → silent overwrite with DB content, baselines reset, dirty=false', () => {
    useEditorStore.getState().openNote(makeNote('memo', 'original'));
    useEditorStore.getState().applyNoteAppliedFromAi('memo', 'original\n\nmilk', 'milk');
    const tab = getTab('memo');
    expect(tab).toBeDefined();
    expect(tab?.content).toBe('original\n\nmilk');
    expect(tab?.originalContent).toBe('original\n\nmilk');
    expect(tab?.dirty).toBe(false);
  });

  it('dirty tab → auto-merge: user edits kept, AI text appended, baseline = DB', () => {
    useEditorStore.getState().openNote(makeNote('memo', 'baseline'));
    useEditorStore.getState().updateContent('memo', 'baseline + local edit');
    expect(getTab('memo')?.dirty).toBe(true);

    useEditorStore.getState().applyNoteAppliedFromAi('memo', 'baseline\n\nmilk', 'milk');

    const tab = getTab('memo');
    expect(tab?.content).toBe('baseline + local edit\n\nmilk');
    // New save baseline reflects what the DB currently holds (post-AI).
    expect(tab?.originalContent).toBe('baseline\n\nmilk');
    expect(tab?.dirty).toBe(true);
  });

  it('dirty tab + second apply → second append lands too', () => {
    useEditorStore.getState().openNote(makeNote('memo', 'baseline'));
    useEditorStore.getState().updateContent('memo', 'baseline + mine');

    useEditorStore.getState().applyNoteAppliedFromAi('memo', 'baseline\n\nmilk', 'milk');
    useEditorStore.getState().applyNoteAppliedFromAi('memo', 'baseline\n\nmilk\n\neggs', 'eggs');

    const tab = getTab('memo');
    expect(tab?.content).toBe('baseline + mine\n\nmilk\n\neggs');
    expect(tab?.originalContent).toBe('baseline\n\nmilk\n\neggs');
    expect(tab?.dirty).toBe(true);
  });
});

describe('requestSaveOrConflict / resolveConflict', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: [], activeTabId: null, conflictPrompt: null });
    vi.restoreAllMocks();
  });

  function openWithPending(pending: PendingAiUpdate, localContent = 'baseline') {
    useEditorStore.getState().openNote(makeNote('n1', 'baseline'));
    // Simulate user having already edited locally before the conflict check.
    if (localContent !== 'baseline') {
      useEditorStore.getState().updateContent('n1', localContent);
    }
    useEditorStore.getState().stageAiUpdate('n1', pending);
  }

  it('no pending update → delegates to saveNote (no prompt)', async () => {
    const patchSpy = vi.spyOn(api, 'updateNote').mockResolvedValue({
      success: true,
      data: { id: 'n1', content: 'baseline', tags: [] } as unknown as Note,
    });
    useEditorStore.getState().openNote(makeNote('n1', 'baseline'));
    useEditorStore.getState().updateContent('n1', 'baseline + local');

    await useEditorStore.getState().requestSaveOrConflict('n1');

    expect(useEditorStore.getState().conflictPrompt).toBeNull();
    expect(patchSpy).toHaveBeenCalledOnce();
  });

  it('pending update with no conflict → saves through pending path', async () => {
    const patchSpy = vi.spyOn(api, 'patchNote').mockResolvedValue({
      success: true,
      data: { id: 'n1', content: 'ai version', tags: [] } as unknown as Note,
    });
    // AI's original baselines exactly match what the tab has → no conflict
    openWithPending({
      action: 'update',
      content: 'ai version',
      tags: [],
      folder_id: null,
      original_content: 'baseline',
      original_tags: [],
      original_folder_id: null,
    });

    await useEditorStore.getState().requestSaveOrConflict('n1');

    expect(useEditorStore.getState().conflictPrompt).toBeNull();
    expect(patchSpy).toHaveBeenCalledOnce();
  });

  it('pending update WITH conflict → sets prompt and skips save', async () => {
    const patchSpy = vi.spyOn(api, 'patchNote').mockResolvedValue({
      success: true,
      data: { id: 'n1', content: 'x', tags: [] } as unknown as Note,
    });
    // AI thought the content was "old" but the tab's baseline is "baseline"
    openWithPending({
      action: 'update',
      content: 'ai version',
      tags: [],
      folder_id: null,
      original_content: 'something else',
      original_tags: [],
      original_folder_id: null,
    });

    await useEditorStore.getState().requestSaveOrConflict('n1');

    const prompt = useEditorStore.getState().conflictPrompt;
    expect(prompt).not.toBeNull();
    expect(prompt?.tabId).toBe('n1');
    expect(prompt?.conflict.contentChanged).toBe(true);
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('resolveConflict(accept-ai) overwrites tab with AI payload and saves', async () => {
    const patchSpy = vi.spyOn(api, 'patchNote').mockResolvedValue({
      success: true,
      data: { id: 'n1', content: 'ai version', tags: [] } as unknown as Note,
    });
    openWithPending({
      action: 'update',
      content: 'ai version',
      tags: ['#ai'],
      folder_id: null,
      original_content: 'something else',
      original_tags: [],
      original_folder_id: null,
    });
    await useEditorStore.getState().requestSaveOrConflict('n1');

    await useEditorStore.getState().resolveConflict('accept-ai');

    expect(useEditorStore.getState().conflictPrompt).toBeNull();
    expect(patchSpy).toHaveBeenCalledOnce();
    const tab = getTab('n1');
    expect(tab?.content).toBe('ai version');
  });

  it('dirty tab at stage time → pre-stage content captured → conflict on save', async () => {
    const patchSpy = vi.spyOn(api, 'patchNote').mockResolvedValue({
      success: true,
      data: { id: 'n1', content: 'x', tags: [] } as unknown as Note,
    });
    // 1. Open a clean note
    useEditorStore.getState().openNote(makeNote('n1', 'baseline'));
    // 2. User edits locally (tab is now dirty), baseline unchanged
    useEditorStore.getState().updateContent('n1', 'baseline + mine');
    expect(getTab('n1')?.dirty).toBe(true);
    // 3. AI proposes an update — its `original_content` matches the tab's
    //    save baseline ("baseline"), so the server-baseline detect sees
    //    NO conflict. But stage overwrites the user's in-flight edits.
    useEditorStore.getState().stageAiUpdate('n1', {
      action: 'update',
      content: 'ai version',
      tags: [],
      folder_id: null,
      original_content: 'baseline',
      original_tags: [],
      original_folder_id: null,
    });

    await useEditorStore.getState().requestSaveOrConflict('n1');

    const prompt = useEditorStore.getState().conflictPrompt;
    expect(prompt).not.toBeNull();
    expect(prompt?.conflict.contentChanged).toBe(true);
    // Pre-stage local content is retained on the pending payload so the
    // dialog can diff against it and `keep-mine` can restore it.
    expect(prompt?.pending.pre_stage_content).toBe('baseline + mine');
    expect(patchSpy).not.toHaveBeenCalled();
  });

  it('clean tab at stage time → no pre-stage capture → no local-edit conflict', async () => {
    const patchSpy = vi.spyOn(api, 'patchNote').mockResolvedValue({
      success: true,
      data: { id: 'n1', content: 'ai', tags: [] } as unknown as Note,
    });
    useEditorStore.getState().openNote(makeNote('n1', 'baseline'));
    // Skip the local edit — tab stays clean before stageAiUpdate fires.
    useEditorStore.getState().stageAiUpdate('n1', {
      action: 'update',
      content: 'ai',
      tags: [],
      folder_id: null,
      original_content: 'baseline',
      original_tags: [],
      original_folder_id: null,
    });

    await useEditorStore.getState().requestSaveOrConflict('n1');

    // No user edits were overwritten, baselines match → no prompt.
    expect(useEditorStore.getState().conflictPrompt).toBeNull();
    expect(patchSpy).toHaveBeenCalledOnce();
  });

  it('resolveConflict(keep-mine) restores pre-stage content when present', async () => {
    vi.spyOn(api, 'updateNote').mockResolvedValue({
      success: true,
      data: { id: 'n1', content: 'baseline + mine', tags: [] } as unknown as Note,
    });
    useEditorStore.getState().openNote(makeNote('n1', 'baseline'));
    useEditorStore.getState().updateContent('n1', 'baseline + mine');
    useEditorStore.getState().stageAiUpdate('n1', {
      action: 'update',
      content: 'ai version',
      tags: [],
      folder_id: null,
      original_content: 'baseline',
      original_tags: [],
      original_folder_id: null,
    });
    await useEditorStore.getState().requestSaveOrConflict('n1');

    await useEditorStore.getState().resolveConflict('keep-mine');

    // Tab content should be the user's pre-stage version, not AI's.
    expect(getTab('n1')?.content).toBe('baseline + mine');
    expect(getTab('n1')?.pendingAiUpdate).toBeNull();
  });

  it('resolveConflict(keep-mine) drops pendingAiUpdate and saves plain', async () => {
    const putSpy = vi.spyOn(api, 'updateNote').mockResolvedValue({
      success: true,
      data: { id: 'n1', content: 'local edit', tags: [] } as unknown as Note,
    });
    openWithPending(
      {
        action: 'update',
        content: 'ai version',
        tags: [],
        folder_id: null,
        original_content: 'something else',
        original_tags: [],
        original_folder_id: null,
      },
      // simulate the user having edited locally; stageAiUpdate replaces
      // content, so overwrite it back to what the "local" state should be
    );
    useEditorStore.getState().updateContent('n1', 'local edit');
    await useEditorStore.getState().requestSaveOrConflict('n1');

    await useEditorStore.getState().resolveConflict('keep-mine');

    expect(useEditorStore.getState().conflictPrompt).toBeNull();
    expect(putSpy).toHaveBeenCalledOnce();
    expect(getTab('n1')?.pendingAiUpdate).toBeNull();
  });
});
