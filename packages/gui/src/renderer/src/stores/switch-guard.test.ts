import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaveResult, TabState } from './editor-store';
import { useEditorStore } from './editor-store';
import { useSwitchGuard } from './switch-guard';

const saved = (id: string): SaveResult => ({ status: 'saved', ok: true, noteId: id });
const failed = (id: string): SaveResult => ({ status: 'failed', ok: false, noteId: id });

function dirtyTab(noteId: string): TabState {
  return {
    noteId,
    title: noteId,
    content: 'edited',
    originalContent: '',
    tags: [],
    originalTags: [],
    folderId: null,
    originalFolderId: null,
    originalUpdatedAt: '',
    dirty: true,
    isDraft: false,
    pendingAiUpdate: null,
    preview: false,
  };
}

beforeEach(() => {
  useSwitchGuard.setState({ open: false, unsavedCount: 0, saving: false, saveFailed: false });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

describe('switch-guard', () => {
  it('no dirty tabs → request resolves true immediately, no prompt', async () => {
    const proceed = await useSwitchGuard.getState().request();
    expect(proceed).toBe(true);
    expect(useSwitchGuard.getState().open).toBe(false);
  });

  it('dirty tabs → opens the prompt with the count', () => {
    useEditorStore.setState({ tabs: [dirtyTab('a'), dirtyTab('b')] });
    void useSwitchGuard.getState().request();
    expect(useSwitchGuard.getState().open).toBe(true);
    expect(useSwitchGuard.getState().unsavedCount).toBe(2);
  });

  it('放弃并切换 (discard) → resolves true and closes', async () => {
    useEditorStore.setState({ tabs: [dirtyTab('a')] });
    const p = useSwitchGuard.getState().request();
    useSwitchGuard.getState().discard();
    expect(await p).toBe(true);
    expect(useSwitchGuard.getState().open).toBe(false);
  });

  it('取消 (cancel) → resolves false and closes', async () => {
    useEditorStore.setState({ tabs: [dirtyTab('a')] });
    const p = useSwitchGuard.getState().request();
    useSwitchGuard.getState().cancel();
    expect(await p).toBe(false);
    expect(useSwitchGuard.getState().open).toBe(false);
  });

  it('保存全部并切换 (saveAll) → saves every dirty tab, then resolves true', async () => {
    const saveNote = vi.fn(async (id: string) => saved(id));
    useEditorStore.setState({ tabs: [dirtyTab('a'), dirtyTab('b')], saveNote });
    const p = useSwitchGuard.getState().request();
    await useSwitchGuard.getState().saveAll();
    expect(saveNote).toHaveBeenCalledWith('a');
    expect(saveNote).toHaveBeenCalledWith('b');
    expect(await p).toBe(true);
    expect(useSwitchGuard.getState().open).toBe(false);
  });

  it('saveAll with a failing save → keeps prompt open, flags saveFailed, does not resolve', async () => {
    const saveNote = vi.fn(async (id: string) => (id === 'b' ? failed(id) : saved(id))); // 'b' fails
    useEditorStore.setState({ tabs: [dirtyTab('a'), dirtyTab('b')], saveNote });
    let settled = false;
    void useSwitchGuard
      .getState()
      .request()
      .then(() => {
        settled = true;
      });
    await useSwitchGuard.getState().saveAll();
    expect(useSwitchGuard.getState().open).toBe(true);
    expect(useSwitchGuard.getState().saving).toBe(false);
    expect(useSwitchGuard.getState().saveFailed).toBe(true);
    expect(settled).toBe(false);
  });
});
