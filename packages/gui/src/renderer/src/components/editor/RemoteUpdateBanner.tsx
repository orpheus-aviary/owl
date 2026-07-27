import { Button } from '@/components/ui/button';
import { useEditorStore } from '@/stores/editor-store';
import { RefreshCw, X } from 'lucide-react';
import { useCallback } from 'react';

/**
 * Problem A / Phase 1b — "远端已更新" strip.
 *
 * Shown when a sync round pulled a newer version of the note this tab is
 * editing AND the tab had unsaved work, so it could not be refreshed in place.
 * Clean tabs never reach here: they adopt the remote version silently, because
 * there is nothing of the user's to lose.
 *
 * A banner rather than a modal on purpose — multi-device edits to the SAME note
 * are rare, and interrupting typing for something the user may not care about
 * is worse than a persistent strip. Ignoring it is safe: the save path sends
 * `expected_updated_at`, so a stale write 409s into `<VersionConflictDialog>`
 * (with a diff) instead of silently clobbering the remote edit.
 */
export function RemoteUpdateBanner({ noteId }: { noteId: string }) {
  const loadRemoteIntoTab = useEditorStore((s) => s.loadRemoteIntoTab);
  const dismissRemoteUpdated = useEditorStore((s) => s.dismissRemoteUpdated);

  const load = useCallback(() => {
    void loadRemoteIntoTab(noteId);
  }, [loadRemoteIntoTab, noteId]);

  const dismiss = useCallback(() => {
    dismissRemoteUpdated(noteId);
  }, [dismissRemoteUpdated, noteId]);

  return (
    <output className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200 shrink-0">
      <RefreshCw className="size-3.5 shrink-0" />
      <span className="flex-1 min-w-0">
        这条笔记在别处被修改过。你有未保存的改动，所以没有自动更新。
      </span>
      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={load}>
        加载远端（放弃本地改动）
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0"
        onClick={dismiss}
        aria-label="忽略提示"
        title="继续编辑；保存时会提示版本冲突"
      >
        <X className="size-3.5" />
      </Button>
    </output>
  );
}
