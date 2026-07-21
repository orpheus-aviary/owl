import { useBrowserStore } from '@/stores/browser-store';
import { useConfigStore } from '@/stores/config-store';
import { useConflictsStore } from '@/stores/conflicts-store';
import { useEditorStore } from '@/stores/editor-store';
import { useFolderStore } from '@/stores/folder-store';
import { useNoteStore } from '@/stores/note-store';
import { isStale, useSessionEpoch } from '@/stores/session-epoch';
import { useSyncStatus } from '@/stores/sync-status';

/**
 * ③ 会话隔离原语 — the single awaitable cold-start entry for a session.
 *
 * Before ③, cold-start fetches were scattered across mount effects (config +
 * conflicts in `MainApp`, notes in `NoteList`, tree/panel in `FolderPanel`) with
 * no way to know when the session's first-paint data had all landed. This
 * gathers them into one place so `SessionCoordinator` can await the whole set
 * and only then drop the bootstrap overlay.
 *
 * `Promise.allSettled` (not `all`): one slow/failed fetch must not block the
 * others — each store already surfaces its own error, and a partial cold start
 * is better than a hung overlay.
 *
 * Every fetch is generation-guarded internally (see the store actions), so a
 * session switch mid-bootstrap simply drops the stale writes. The config
 * hydration below re-checks `isStale` because it reads config state written by
 * its own fetch and forwards it into two other stores.
 *
 * The mount fetches these replace have been removed from `MainApp` — leaving
 * them would double every cold-start request.
 */
export async function bootstrapSession(gen: number): Promise<void> {
  await Promise.allSettled([
    useConfigStore
      .getState()
      .fetch()
      .then(() => {
        if (isStale(gen)) return;
        // Hydrate session-level defaults from config (replaces MainApp's mount
        // effect): editor mode + browser sort. One-shot — users can still
        // change them live.
        const { editor, browser } = useConfigStore.getState();
        useEditorStore.getState().setMode(editor.default_mode);
        const sortKey = `${browser.default_sort_field}_${browser.default_sort_direction}` as const;
        useBrowserStore.getState().setSortKey(sortKey);
      }),
    useFolderStore
      .getState()
      .fetch(), // folder tree
    useFolderStore
      .getState()
      .fetchPanelNotes(), // folder-panel inline notes
    useNoteStore
      .getState()
      .fetchNotes(), // first-screen note list
    useConflictsStore
      .getState()
      .refresh(), // sidebar conflict count
    useSyncStatus
      .getState()
      .fetch(), // sync status probe
  ]);

  // Close the overlay only if this is still the current session — a bootstrap
  // superseded by a newer begin* must never flip a newer session to `active`.
  useSessionEpoch.getState().endBootstrap(gen);
}
