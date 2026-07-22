import { usePendingDeleteStore } from '@/components/DeleteConfirmDialog';
import { afterEach, describe, expect, it } from 'vitest';
import { useAiStore } from './ai-store';
import { useBrowserStore } from './browser-store';
import { useConfigStore } from './config-store';
import { useConflictsStore } from './conflicts-store';
import { useEditorStore } from './editor-store';
import { useFolderStore } from './folder-store';
import { useNoteNavGuard } from './note-nav-guard';
import { useNoteStore } from './note-store';
import { useReminderStore } from './reminder-store';
import { resetAllStores } from './reset';
import { useSyncStatus } from './sync-status';
import { useTagStore } from './tag-store';

const NOTE = {
  id: 'n1',
  content: '# hi',
  tags: [],
  folderId: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  trashLevel: 0,
  pinnedAt: null,
  autoDeleteAt: null,
} as unknown as Parameters<typeof useNoteStore.setState>[0];

function seedAllStores(): void {
  useNoteStore.setState({ notes: [NOTE as never], total: 1, query: 'foo', page: 3 });
  useFolderStore.setState({
    folders: [{ id: 'f1' } as never],
    panelNotes: [NOTE as never],
    expanded: new Set(['f1']),
    panelOpen: true,
  });
  useTagStore.setState({ tags: [{ id: 't1' } as never], frequentTags: [{ id: 't1' } as never] });
  useReminderStore.setState({ notes: [NOTE as never], timeRange: 'week' });
  useBrowserStore.setState({ query: 'q', activeTags: ['x'], notes: [NOTE as never], total: 1 });
  useConfigStore.setState({ config: { editor: { default_mode: 'edit' } } as never, error: 'boom' });
  useConflictsStore.setState({ count: 5, list: [{ id: 'c1' } as never], error: 'boom' });
  useSyncStatus.setState({
    snapshot: { state: 'idle' } as never,
    probeStatus: 'ok',
    minDisplayUntilMs: 999,
  });
  useEditorStore.setState({ tabs: [{ noteId: 'n1' } as never], activeTabId: 'n1' });
  useAiStore.setState({
    conversations: [{ id: 'a1' } as never],
    conversationsLoaded: true,
    activeConversationId: 'a1',
    messagesByConversation: { a1: [] },
  });
  usePendingDeleteStore.setState({ noteId: 'n1', title: 'x', kind: 'confirm' });
}

afterEach(() => {
  resetAllStores();
});

describe('resetAllStores', () => {
  it('wipes every account-scoped store back to its initial per-session shape', () => {
    seedAllStores();
    resetAllStores();

    expect(useNoteStore.getState().notes).toEqual([]);
    expect(useNoteStore.getState().query).toBe('');
    expect(useNoteStore.getState().page).toBe(1);

    expect(useFolderStore.getState().folders).toEqual([]);
    expect(useFolderStore.getState().panelNotes).toEqual([]);
    expect(useFolderStore.getState().expanded.size).toBe(0);

    expect(useTagStore.getState().tags).toEqual([]);
    expect(useTagStore.getState().frequentTags).toEqual([]);

    expect(useReminderStore.getState().notes).toEqual([]);
    expect(useReminderStore.getState().timeRange).toBe('all');

    expect(useBrowserStore.getState().query).toBe('');
    expect(useBrowserStore.getState().activeTags).toEqual([]);
    expect(useBrowserStore.getState().notes).toEqual([]);

    expect(useConfigStore.getState().config).toBe(null);
    expect(useConfigStore.getState().error).toBe(null);

    expect(useConflictsStore.getState().count).toBe(0);
    expect(useConflictsStore.getState().list).toEqual([]);

    expect(useSyncStatus.getState().snapshot).toBe(null);
    expect(useSyncStatus.getState().probeStatus).toBe('pending');
    expect(useSyncStatus.getState().minDisplayUntilMs).toBe(0);

    expect(useEditorStore.getState().tabs).toEqual([]);
    expect(useEditorStore.getState().activeTabId).toBe(null);

    expect(useAiStore.getState().conversations).toEqual([]);
    expect(useAiStore.getState().conversationsLoaded).toBe(false);
    expect(useAiStore.getState().activeConversationId).toBe(null);

    expect(usePendingDeleteStore.getState().noteId).toBe(null);
  });

  it('preserves the folder panel open flag (a device UI pref, not account state)', () => {
    useFolderStore.setState({ panelOpen: true });
    resetAllStores();
    expect(useFolderStore.getState().panelOpen).toBe(true);
  });

  it('cancels a pending note-open and clears its prompt (§4.1.7)', async () => {
    // A dirty active tab makes the guard pause on its save/discard prompt.
    useEditorStore.setState({
      tabs: [
        { noteId: 'n1', title: 'X', dirty: true, isDraft: false, pendingAiUpdate: null } as never,
      ],
      activeTabId: 'n1',
    });
    const nav = { navigate: () => {}, path: () => '/', search: () => '', state: () => undefined };
    const open = useNoteNavGuard.getState().open({ noteId: 'n2' }, nav);
    expect(useNoteNavGuard.getState().prompt).not.toBeNull();

    resetAllStores();

    expect(await open).toBe('cancelled');
    expect(useNoteNavGuard.getState().prompt).toBeNull();
  });
});
