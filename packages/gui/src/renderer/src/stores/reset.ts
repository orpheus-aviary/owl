import { usePendingDeleteStore } from '@/components/DeleteConfirmDialog';
import { resetNoteIdCaches } from '@/lib/note-id-refs';
import { useAiStore } from './ai-store';
import { useBrowserStore } from './browser-store';
import { useConfigStore } from './config-store';
import { useConflictsStore } from './conflicts-store';
import { useEditorStore } from './editor-store';
import { useFolderStore } from './folder-store';
import { useNoteNavGuard } from './note-nav-guard';
import { useNoteStore } from './note-store';
import { useReminderStore } from './reminder-store';
import { useSyncStatus } from './sync-status';
import { useTagStore } from './tag-store';

/**
 * ③ 会话隔离原语 — the single owner of session-teardown cleanup.
 *
 * Wipes every account-scoped store back to its initial per-session shape plus
 * the module-level `note-id-refs` caches. Each store's own `reset()` is
 * self-contained (ai aborts its in-flight streams, sync-status clears its
 * pending timer + in-flight probe), so this is just the roster.
 *
 * Deliberately NOT reset:
 *   - `data-bus` — a monotonic counter; zeroing it would break the "always
 *     increases" invariant its subscribers rely on, and a mid-reset bump would
 *     kick a fetch into the half-cleared session.
 *   - `session-epoch` — the coordinator that drives this; it owns the epoch.
 *
 * Called by `invalidateSession` (clear only) and `activateSession` /
 * `activateWebSession` (clear then bootstrap). It never fetches — bringing the
 * new session up is `bootstrapSession`'s job.
 */
export function resetAllStores(): void {
  // Module-level caches first — no store state depends on them.
  resetNoteIdCaches();

  useFolderStore.getState().reset();
  useConfigStore.getState().reset();
  useReminderStore.getState().reset();
  useConflictsStore.getState().reset();
  useNoteStore.getState().reset();
  useTagStore.getState().reset();
  useSyncStatus.getState().reset();
  useBrowserStore.getState().reset();
  useAiStore.getState().reset();
  useEditorStore.getState().reset();
  // ⑤: bump navSeq so any in-flight/pending note open is invalidated and its
  // Promise settles `cancelled` — a stale prepare must never stage / navigate
  // into the new session. Runs AFTER editor reset (which clears the tabs its
  // pending open referenced).
  useNoteNavGuard.getState().reset();
  usePendingDeleteStore.getState().reset();
}
