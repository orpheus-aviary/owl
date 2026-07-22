import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetDraftAlias,
  loadNoteById,
  registerDraftAlias,
  resolveDraftAlias,
  useEditorStore,
} from './editor-store';
import type { PendingAiUpdate } from './editor-store';
import { useSessionEpoch } from './session-epoch';

// Optimistic-concurrency (CAS) is gated on `getPlatform().remoteClient`. Mock
// the platform module so each test can flip web (true) vs desktop (false).
const platformMock = vi.hoisted(() => ({ remoteClient: false }));
vi.mock('@/platform', () => ({
  getPlatform: () => ({ remoteClient: platformMock.remoteClient, daemonBaseUrl: () => '' }),
}));

// saveNote bumps the data-bus, which fans out to note-store / folder-store /
// browser-store subscribers — each one issues a fire-and-forget fetchNotes /
// fetchPanelNotes against `window.owlAPI?.daemonUrl`. In Node there's no
// `window`. Stub it to a minimal shape so those side fetches resolve to a
// fake-success response without throwing a `ReferenceError` we can't catch.
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
    pinnedAt: null,
    position: null,
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
    const patchSpy = vi.spyOn(api, 'patchNote').mockResolvedValue({
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
    vi.spyOn(api, 'patchNote').mockResolvedValue({
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
    const putSpy = vi.spyOn(api, 'patchNote').mockResolvedValue({
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

/**
 * The quit-time UnsavedTabsDialog reads these helpers to decide whether
 * to prompt. Keep them aligned with the `saveNote` guard clause — a tab
 * with any of dirty / isDraft / pendingAiUpdate counts as unsaved.
 */
describe('hasUnsavedTabs / getUnsavedTabs', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
  });

  it('returns false / empty when all tabs are clean', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'hello'));
    expect(useEditorStore.getState().hasUnsavedTabs()).toBe(false);
    expect(useEditorStore.getState().getUnsavedTabs()).toEqual([]);
  });

  it('returns true when a tab is dirty (user edit)', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'hello'));
    useEditorStore.getState().updateContent('n1', 'hello edited');
    expect(useEditorStore.getState().hasUnsavedTabs()).toBe(true);
    const unsaved = useEditorStore.getState().getUnsavedTabs();
    expect(unsaved).toHaveLength(1);
    expect(unsaved[0]?.noteId).toBe('n1');
  });

  it('returns true for an AI draft tab even before any edit', () => {
    useEditorStore.getState().openAiDraft({
      note_id: 'draft_abc',
      content: 'AI made this',
      tags: [],
      folder_id: null,
      action: 'create',
    });
    // openAiDraft marks the tab dirty (so Cmd+S lands), but the core
    // signal is isDraft — the helper should pick that up either way.
    expect(useEditorStore.getState().hasUnsavedTabs()).toBe(true);
  });

  it('returns true for a tab with pendingAiUpdate even when dirty flag is false', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'hello'));
    useEditorStore.getState().stageAiUpdate('n1', {
      action: 'update',
      content: 'ai version',
      tags: [],
      folder_id: null,
      original_content: 'hello',
      original_tags: [],
      original_folder_id: null,
    });
    // stageAiUpdate sets dirty:true via overwrite; simulate the (rare)
    // post-save state where dirty has been cleared but the pending
    // payload is still hanging around — helper must still flag it.
    useEditorStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.noteId === 'n1' ? { ...t, dirty: false } : t)),
    }));
    expect(useEditorStore.getState().hasUnsavedTabs()).toBe(true);
  });

  it('preserves tab order in getUnsavedTabs and filters clean tabs out', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'first'));
    useEditorStore.getState().openNote(makeNote('n2', 'second'));
    useEditorStore.getState().openNote(makeNote('n3', 'third'));
    useEditorStore.getState().updateContent('n1', 'first edited');
    // n2 stays clean
    useEditorStore.getState().updateContent('n3', 'third edited');
    const unsaved = useEditorStore.getState().getUnsavedTabs();
    expect(unsaved.map((t) => t.noteId)).toEqual(['n1', 'n3']);
  });
});

/**
 * P3.4-e preview/pinned tab semantics. Every invariant below protects a
 * specific failure mode the user could hit by clicking through the list:
 * dirty or AI-staged tabs getting silently replaced, preview tabs shuffling
 * position, fetch races dropping the user on stale content, etc.
 */
describe('openNote preview/pinned semantics (P3.4-e)', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: [], activeTabId: null, conflictPrompt: null });
  });

  it('default (no opts) opens a pinned tab', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'hello'));
    expect(getTab('n1')?.preview).toBe(false);
  });

  it('{preview:true} opens a preview tab', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'hello'), { preview: true });
    expect(getTab('n1')?.preview).toBe(true);
  });

  it('two different preview opens replace in place — only one preview tab exists, length stays 1', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'one'), { preview: true });
    useEditorStore.getState().openNote(makeNote('n2', 'two'), { preview: true });
    const tabs = useEditorStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.noteId).toBe('n2');
    expect(tabs[0]?.preview).toBe(true);
  });

  it('preview tab position is preserved across replacement (not appended)', () => {
    // Pin n1, then open n2 as preview → n1 at idx 0, n2-preview at idx 1.
    // Swap n2 preview to n3 preview → n3 must land at idx 1, not idx 2.
    useEditorStore.getState().openNote(makeNote('n1', 'one')); // pinned, idx 0
    useEditorStore.getState().openNote(makeNote('n2', 'two'), { preview: true });
    useEditorStore.getState().openNote(makeNote('n3', 'three'), { preview: true });
    const tabs = useEditorStore.getState().tabs;
    expect(tabs.map((t) => t.noteId)).toEqual(['n1', 'n3']);
    expect(tabs[1]?.preview).toBe(true);
  });

  it('opening the same note again with {preview:true} keeps it as preview', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'hello'), { preview: true });
    useEditorStore.getState().openNote(makeNote('n1', 'hello'), { preview: true });
    expect(getTab('n1')?.preview).toBe(true);
  });

  it('opening the same preview note with {preview:false} promotes it to pinned', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'hello'), { preview: true });
    useEditorStore.getState().openNote(makeNote('n1', 'hello'), { preview: false });
    expect(getTab('n1')?.preview).toBe(false);
  });

  it('opening an already-pinned tab with {preview:true} does NOT demote it', () => {
    // Pinned is a one-way state — a stray preview click must not replace
    // or re-preview a tab the user explicitly committed to.
    useEditorStore.getState().openNote(makeNote('n1', 'hello'));
    useEditorStore.getState().openNote(makeNote('n1', 'hello'), { preview: true });
    expect(getTab('n1')?.preview).toBe(false);
  });

  it('pinned tab still refreshes baseline on re-open (clean tab path)', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'old content'));
    // Clean tab: fresh snapshot replaces content + originalContent.
    useEditorStore.getState().openNote(makeNote('n1', 'new content'), { preview: true });
    const tab = getTab('n1');
    expect(tab?.content).toBe('new content');
    expect(tab?.originalContent).toBe('new content');
    // But preview must NOT flip to true.
    expect(tab?.preview).toBe(false);
  });

  it('pinned dirty tab still rebases originalContent on re-open; preview stays false', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'v1'));
    useEditorStore.getState().updateContent('n1', 'user edit');
    expect(getTab('n1')?.dirty).toBe(true);

    useEditorStore.getState().openNote(makeNote('n1', 'v2'), { preview: true });
    const tab = getTab('n1');
    // Baseline moved forward — dirty detection against new server state.
    expect(tab?.originalContent).toBe('v2');
    // User's live edits are preserved.
    expect(tab?.content).toBe('user edit');
    expect(tab?.preview).toBe(false);
  });

  it('clean→dirty edge forces preview=false (first-keystroke promotion)', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'baseline'), { preview: true });
    expect(getTab('n1')?.preview).toBe(true);
    useEditorStore.getState().updateContent('n1', 'baseline edited');
    expect(getTab('n1')?.dirty).toBe(true);
    expect(getTab('n1')?.preview).toBe(false);
  });

  it('updateTags clean→dirty also promotes out of preview', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'hello'), { preview: true });
    useEditorStore.getState().updateTags('n1', [{ id: '#x', tagType: '#', tagValue: 'x' }]);
    expect(getTab('n1')?.preview).toBe(false);
  });

  it('markSaved clears preview (saved tab is user-authoritative)', () => {
    useEditorStore.getState().openNote(makeNote('n1', 'hello'), { preview: true });
    // Force preview back to true (simulating a path that didn't dirty the tab).
    useEditorStore.setState((s) => ({
      tabs: s.tabs.map((t) => ({ ...t, preview: true })),
    }));
    useEditorStore.getState().markSaved('n1', 'hello', []);
    expect(getTab('n1')?.preview).toBe(false);
  });

  it('openAiDraft creates a pinned tab (never a preview)', () => {
    useEditorStore.getState().openAiDraft({
      note_id: 'draft_abc',
      content: 'AI wrote this',
      tags: [],
      folder_id: null,
      action: 'create',
    });
    expect(getTab('draft_abc')?.preview).toBe(false);
  });

  it('stageAiUpdate forces preview=false — AI payload must not be replaceable', () => {
    // Open as preview, then AI stages an update on top. The tab now carries
    // unsaved AI intent; a subsequent preview click on a different note
    // should replace a *different* preview tab (or create one), never this.
    useEditorStore.getState().openNote(makeNote('n1', 'baseline'), { preview: true });
    expect(getTab('n1')?.preview).toBe(true);

    useEditorStore.getState().stageAiUpdate('n1', {
      action: 'update',
      content: 'ai version',
      tags: [],
      folder_id: null,
      original_content: 'baseline',
      original_tags: [],
      original_folder_id: null,
    });
    expect(getTab('n1')?.preview).toBe(false);

    // Opening another note as preview should append/replace its own slot —
    // n1 (now pinned) must still exist.
    useEditorStore.getState().openNote(makeNote('n2', 'other'), { preview: true });
    const tabs = useEditorStore.getState().tabs;
    expect(tabs.map((t) => t.noteId).sort()).toEqual(['n1', 'n2']);
  });
});

/**
 * Phase B2 — web optimistic concurrency (CAS). saveNote sends
 * `expected_updated_at` only on `remoteClient`, surfaces a 409
 * `VERSION_MISMATCH` as a `versionConflict`, and the desktop path stays
 * byte-for-byte unchanged. These drive `saveNote` end-to-end, so they stub the
 * `api` layer with `vi.spyOn` (same pattern as the AI-conflict suite above) and
 * `vi.restoreAllMocks()` per test — sibling spies leak otherwise.
 */
function makeNoteAt(id: string, content: string, updatedAt: string): Note {
  return { ...makeNote(id, content), updatedAt };
}

/** The `data` argument of the most recent `api.patchNote` call. */
function lastPatchData(spy: {
  mock: { calls: unknown[][] };
}): Record<string, unknown> | undefined {
  const { calls } = spy.mock;
  return calls.length ? (calls[calls.length - 1][1] as Record<string, unknown>) : undefined;
}

describe('saveNote — web optimistic concurrency (B2)', () => {
  const BASE = '2026-06-16T00:00:00.000Z';

  beforeEach(() => {
    vi.restoreAllMocks();
    useEditorStore.setState({ tabs: [], activeTabId: null, versionConflict: null });
    platformMock.remoteClient = false;
  });

  it('web save sends expected_updated_at and refreshes the baseline on success', async () => {
    platformMock.remoteClient = true;
    const newUpdatedAt = '2026-06-16T01:00:00.000Z';
    const patchSpy = vi
      .spyOn(api, 'patchNote')
      .mockResolvedValue({ success: true, data: makeNoteAt('n1', 'hello world', newUpdatedAt) });
    useEditorStore.getState().openNote(makeNoteAt('n1', 'hello', BASE));
    useEditorStore.getState().updateContent('n1', 'hello world');

    const result = await useEditorStore.getState().saveNote('n1');
    expect(result.ok).toBe(true);
    expect(result.status).toBe('saved');
    expect(result.noteId).toBe('n1');
    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(lastPatchData(patchSpy)?.expected_updated_at).toBe(new Date(BASE).getTime());
    // Baseline advances to the version the server just wrote.
    expect(getTab('n1')?.originalUpdatedAt).toBe(newUpdatedAt);
    expect(getTab('n1')?.dirty).toBe(false);
  });

  it('desktop save omits expected_updated_at (zero regression)', async () => {
    platformMock.remoteClient = false;
    const patchSpy = vi
      .spyOn(api, 'patchNote')
      .mockResolvedValue({ success: true, data: makeNoteAt('n1', 'hello world', BASE) });
    useEditorStore.getState().openNote(makeNoteAt('n1', 'hello', BASE));
    useEditorStore.getState().updateContent('n1', 'hello world');

    await useEditorStore.getState().saveNote('n1');
    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(lastPatchData(patchSpy)).toBeDefined();
    expect(lastPatchData(patchSpy)?.expected_updated_at).toBeUndefined();
  });

  it('409 VERSION_MISMATCH re-fetches remote, sets versionConflict, keeps local edits unsaved', async () => {
    platformMock.remoteClient = true;
    const remote = makeNoteAt('n1', 'remote content', '2026-06-16T02:00:00.000Z');
    vi.spyOn(api, 'patchNote').mockRejectedValue(
      new api.ApiError(409, 'VERSION_MISMATCH', 'conflict'),
    );
    const getSpy = vi.spyOn(api, 'getNote').mockResolvedValue({ success: true, data: remote });
    useEditorStore.getState().openNote(makeNoteAt('n1', 'base', BASE));
    useEditorStore.getState().updateContent('n1', 'local edit');

    const result = await useEditorStore.getState().saveNote('n1');
    expect(result.ok).toBe(false);
    expect(result.status).toBe('conflict');
    expect(getSpy).toHaveBeenCalledWith('n1');
    const vc = useEditorStore.getState().versionConflict;
    expect(vc?.tabId).toBe('n1');
    expect(vc?.remote.content).toBe('remote content');
    // Local edits preserved + still dirty (not marked saved).
    expect(getTab('n1')?.content).toBe('local edit');
    expect(getTab('n1')?.dirty).toBe(true);
  });

  it('409 with a failed remote re-fetch returns false and sets no versionConflict', async () => {
    platformMock.remoteClient = true;
    vi.spyOn(api, 'patchNote').mockRejectedValue(
      new api.ApiError(409, 'VERSION_MISMATCH', 'conflict'),
    );
    vi.spyOn(api, 'getNote').mockRejectedValue(new api.ApiError(404, 'NOT_FOUND', 'gone'));
    useEditorStore.getState().openNote(makeNoteAt('n1', 'base', BASE));
    useEditorStore.getState().updateContent('n1', 'local edit');

    const result = await useEditorStore.getState().saveNote('n1');
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(useEditorStore.getState().versionConflict).toBeNull();
  });

  it('a non-VERSION_MISMATCH 409 is not treated as a version conflict', async () => {
    platformMock.remoteClient = true;
    vi.spyOn(api, 'patchNote').mockRejectedValue(
      new api.ApiError(409, 'ALREADY_TRASHED', 'already in trash'),
    );
    const getSpy = vi.spyOn(api, 'getNote');
    useEditorStore.getState().openNote(makeNoteAt('n1', 'base', BASE));
    useEditorStore.getState().updateContent('n1', 'local edit');

    const result = await useEditorStore.getState().saveNote('n1');
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(useEditorStore.getState().versionConflict).toBeNull();
    // No remote re-fetch — only the PATCH was attempted.
    expect(getSpy).not.toHaveBeenCalled();
  });
});

describe('resolveVersionConflict (B2)', () => {
  const BASE = '2026-06-16T00:00:00.000Z';
  const REMOTE_ISO = '2026-06-16T02:00:00.000Z';

  beforeEach(() => {
    vi.restoreAllMocks();
    useEditorStore.setState({ tabs: [], activeTabId: null, versionConflict: null });
    platformMock.remoteClient = true;
  });

  it('load-remote overwrites the tab with the server copy and clears the conflict', async () => {
    useEditorStore.getState().openNote(makeNoteAt('n1', 'base', BASE));
    useEditorStore.getState().updateContent('n1', 'my local');
    const remote = makeNoteAt('n1', 'remote!', REMOTE_ISO);
    useEditorStore.setState({ versionConflict: { tabId: 'n1', remote } });

    await useEditorStore.getState().resolveVersionConflict('load-remote');
    expect(useEditorStore.getState().versionConflict).toBeNull();
    const tab = getTab('n1');
    expect(tab?.content).toBe('remote!');
    expect(tab?.originalContent).toBe('remote!');
    expect(tab?.originalUpdatedAt).toBe(REMOTE_ISO);
    expect(tab?.dirty).toBe(false);
  });

  it('overwrite re-saves against the remote baseline and clears the conflict', async () => {
    const savedIso = '2026-06-16T03:00:00.000Z';
    const patchSpy = vi
      .spyOn(api, 'patchNote')
      .mockResolvedValue({ success: true, data: makeNoteAt('n1', 'my edit', savedIso) });
    useEditorStore.getState().openNote(makeNoteAt('n1', 'base', BASE));
    useEditorStore.getState().updateContent('n1', 'my edit');
    const remote = makeNoteAt('n1', 'remote', REMOTE_ISO);
    useEditorStore.setState({ versionConflict: { tabId: 'n1', remote } });

    const result = await useEditorStore.getState().resolveVersionConflict('overwrite');
    expect(result.ok).toBe(true);
    expect(result.status).toBe('saved');
    expect(useEditorStore.getState().versionConflict).toBeNull();
    // Re-save used the freshly-fetched remote version as the baseline.
    expect(lastPatchData(patchSpy)?.expected_updated_at).toBe(new Date(REMOTE_ISO).getTime());
    expect(getTab('n1')?.originalUpdatedAt).toBe(savedIso);
    expect(getTab('n1')?.dirty).toBe(false);
  });

  it('dismiss keeps local edits and clears only the conflict', async () => {
    useEditorStore.getState().openNote(makeNoteAt('n1', 'base', BASE));
    useEditorStore.getState().updateContent('n1', 'my edit');
    useEditorStore.setState({
      versionConflict: { tabId: 'n1', remote: makeNoteAt('n1', 'remote', REMOTE_ISO) },
    });

    await useEditorStore.getState().resolveVersionConflict('dismiss');
    expect(useEditorStore.getState().versionConflict).toBeNull();
    expect(getTab('n1')?.content).toBe('my edit');
    expect(getTab('n1')?.dirty).toBe(true);
  });
});

describe('versionConflict lifecycle (B2)', () => {
  const BASE = '2026-06-16T00:00:00.000Z';

  beforeEach(() => {
    vi.restoreAllMocks();
    useEditorStore.setState({ tabs: [], activeTabId: null, versionConflict: null });
    platformMock.remoteClient = false;
  });

  it('openNote records originalUpdatedAt from the loaded note', () => {
    useEditorStore.getState().openNote(makeNoteAt('n1', 'x', BASE));
    expect(getTab('n1')?.originalUpdatedAt).toBe(BASE);
  });

  it('syncTabFolderId rebases the updatedAt baseline when given one, else keeps it', () => {
    useEditorStore.getState().openNote(makeNoteAt('n1', 'x', BASE));
    const moved = '2026-06-16T04:00:00.000Z';
    useEditorStore.getState().syncTabFolderId('n1', 'folderX', moved);
    expect(getTab('n1')?.originalFolderId).toBe('folderX');
    expect(getTab('n1')?.originalUpdatedAt).toBe(moved);

    useEditorStore.getState().syncTabFolderId('n1', 'folderY');
    expect(getTab('n1')?.originalUpdatedAt).toBe(moved);
  });

  it('closeTab clears a dangling versionConflict that pointed at it', () => {
    useEditorStore.getState().openNote(makeNoteAt('n1', 'x', BASE));
    useEditorStore.setState({
      versionConflict: { tabId: 'n1', remote: makeNoteAt('n1', 'r', BASE) },
    });
    useEditorStore.getState().closeTab('n1');
    expect(useEditorStore.getState().versionConflict).toBeNull();
  });

  it('closeTab leaves a versionConflict pointing at a different tab intact', () => {
    useEditorStore.getState().openNote(makeNoteAt('n1', 'x', BASE));
    useEditorStore.getState().openNote(makeNoteAt('n2', 'y', BASE));
    useEditorStore.setState({
      versionConflict: { tabId: 'n2', remote: makeNoteAt('n2', 'r', BASE) },
    });
    useEditorStore.getState().closeTab('n1');
    expect(useEditorStore.getState().versionConflict?.tabId).toBe('n2');
  });
});

describe('loadNoteById (§4.1.2 — pure load, no store write)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useEditorStore.setState({ tabs: [], activeTabId: null });
  });

  it('found → returns the note without opening a tab', async () => {
    const note = makeNote('n1', 'hello');
    vi.spyOn(api, 'getNote').mockResolvedValue({ success: true, data: note });
    const result = await loadNoteById('n1');
    expect(result).toEqual({ status: 'found', note });
    // The whole point: it never writes the store.
    expect(useEditorStore.getState().tabs).toEqual([]);
  });

  it('404 → not-found', async () => {
    vi.spyOn(api, 'getNote').mockRejectedValue(new api.ApiError(404, 'NOT_FOUND', 'gone'));
    expect(await loadNoteById('missing')).toEqual({ status: 'not-found' });
  });

  it('session switched mid-fetch → stale', async () => {
    vi.spyOn(api, 'getNote').mockImplementation(async () => {
      // Advance the epoch while the fetch is in flight.
      useSessionEpoch.getState().beginInvalidate();
      return { success: true, data: makeNote('n1', 'x') };
    });
    expect(await loadNoteById('n1')).toEqual({ status: 'stale' });
  });

  it('a 200 without data is a protocol error → throws (not not-found)', async () => {
    vi.spyOn(api, 'getNote').mockResolvedValue({ success: true, data: undefined });
    await expect(loadNoteById('n1')).rejects.toThrow(/200 without data/);
  });

  it('a 401 rethrows (→ load-failed, not not-found)', async () => {
    vi.spyOn(api, 'getNote').mockRejectedValue(new api.ApiError(401, 'UNAUTHORIZED', 'nope'));
    await expect(loadNoteById('n1')).rejects.toBeInstanceOf(api.ApiError);
  });
});

describe('mobileMode (§4.2)', () => {
  beforeEach(() => {
    useEditorStore.getState().reset();
  });

  it('defaults to edit and is written independently of the persisted mode', () => {
    expect(useEditorStore.getState().mobileMode).toBe('edit');
    useEditorStore.getState().setMode('split'); // desktop mode
    useEditorStore.getState().setMobileMode('preview');
    expect(useEditorStore.getState().mobileMode).toBe('preview');
    // setMobileMode must NEVER touch the persisted desktop mode.
    expect(useEditorStore.getState().mode).toBe('split');
  });

  it('reset restores mobileMode to edit', () => {
    useEditorStore.getState().setMobileMode('preview');
    useEditorStore.getState().reset();
    expect(useEditorStore.getState().mobileMode).toBe('edit');
  });
});

describe('draft→real alias (§4.1.6 b)', () => {
  beforeEach(() => {
    useEditorStore.getState().reset(); // clears the alias table
  });

  it('register → resolve, forget removes it', () => {
    registerDraftAlias('draft_abc', 'real1');
    expect(resolveDraftAlias('draft_abc')).toBe('real1');
    forgetDraftAlias('draft_abc');
    expect(resolveDraftAlias('draft_abc')).toBeUndefined();
  });

  it('unknown id resolves to undefined', () => {
    expect(resolveDraftAlias('draft_nope')).toBeUndefined();
  });

  it('reset (session switch) clears the whole table', () => {
    registerDraftAlias('draft_abc', 'real1');
    useEditorStore.getState().reset();
    expect(resolveDraftAlias('draft_abc')).toBeUndefined();
  });
});
