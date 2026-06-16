import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useEditorStore } from '@/stores/editor-store';
import type { VersionConflictDecision } from '@/stores/editor-store';
import { useCallback, useState } from 'react';
import { DiffView } from '../ai/diff/DiffView';

/**
 * Save-time version-conflict resolver (web optimistic concurrency). Mounted
 * once at the app root (`MainApp`); driven entirely by
 * `editorStore.versionConflict`, which a `saveNote` 409 (`VERSION_MISMATCH`)
 * populates after re-fetching the server copy.
 *
 * The local edits live on the tab; `remote` is the freshly-fetched server
 * version. The user picks:
 *   - 用我的版本覆盖 (`overwrite`): re-save against the remote baseline.
 *   - 放弃本地，加载远端 (`load-remote`): drop local edits, load the server copy.
 *   - 取消 (`dismiss`): keep editing locally (the next Cmd+S will 409 again).
 */
export function VersionConflictDialog() {
  const conflict = useEditorStore((s) => s.versionConflict);
  const resolveVersionConflict = useEditorStore((s) => s.resolveVersionConflict);
  const [showDiff, setShowDiff] = useState(false);

  const open = conflict !== null;

  const decide = useCallback(
    async (decision: VersionConflictDecision) => {
      await resolveVersionConflict(decision);
      setShowDiff(false);
    },
    [resolveVersionConflict],
  );

  if (!conflict) return null;

  const tab = useEditorStore.getState().tabs.find((t) => t.noteId === conflict.tabId);
  if (!tab) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // Closing without choosing = dismiss (keep local edits, stay put).
        if (!v) void decide('dismiss');
      }}
    >
      <DialogContent className={showDiff ? 'max-w-3xl' : undefined}>
        <DialogHeader>
          <DialogTitle>笔记已被其他设备或会话修改</DialogTitle>
          <DialogDescription>
            你正在编辑的版本与服务器上的最新版本不一致。选择用本地版本覆盖远端，或放弃本地修改加载远端版本。
          </DialogDescription>
        </DialogHeader>

        {showDiff ? (
          <DiffView
            original={tab.content}
            modified={conflict.remote.content}
            originalLabel="本地版本"
            modifiedLabel="远端版本"
            className="h-96 border border-border rounded-md"
          />
        ) : null}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? '收起差异' : '查看差异'}
          </Button>
          <Button variant="outline" onClick={() => void decide('dismiss')}>
            取消
          </Button>
          <Button variant="outline" onClick={() => void decide('load-remote')}>
            放弃本地，加载远端
          </Button>
          <Button onClick={() => void decide('overwrite')}>用我的版本覆盖</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
