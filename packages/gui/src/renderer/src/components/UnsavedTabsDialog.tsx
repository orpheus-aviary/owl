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
import type { TabState } from '@/stores/editor-store';
import { useCallback, useEffect, useState } from 'react';

type DialogState =
  | { phase: 'idle' }
  | {
      phase: 'prompting';
      queue: TabState[];
      index: number;
    }
  | {
      phase: 'saving';
      queue: TabState[];
      index: number;
    }
  | {
      phase: 'save-failed';
      queue: TabState[];
      index: number;
    };

const IDLE: DialogState = { phase: 'idle' };

/**
 * Sequential "save unsaved tabs?" prompter — Word/VSCode style. Shown
 * when the main process emits `quit:check-unsaved` (Cmd+Q / Quit menu
 * / non-macOS red-cross).
 *
 * Flow per tab (index cursor advances through `queue`):
 *   保存   → requestSaveOrConflict:
 *            - resolves `true`           → cursor++, next tab
 *            - resolves `false` with AI conflict set → close this dialog,
 *              reply `quit.respond(false)`; ConflictDialog takes over
 *            - resolves `false` without conflict     → save-failed phase,
 *              user picks 重试 / 不保存 / 取消
 *   不保存 → cursor++, next tab (tab content stays dirty in-memory; if
 *            the whole flow completes and quit proceeds, process exit
 *            discards naturally. If the user cancels later, the tab is
 *            still dirty for them to keep working on.)
 *   取消   → `quit.respond(false)`, close dialog, keep everything as-is
 */
export function UnsavedTabsDialog() {
  const [state, setState] = useState<DialogState>(IDLE);
  const getUnsavedTabs = useEditorStore((s) => s.getUnsavedTabs);
  const requestSaveOrConflict = useEditorStore((s) => s.requestSaveOrConflict);

  const respond = useCallback((proceed: boolean) => {
    window.owlAPI.quit.respond(proceed);
    setState(IDLE);
  }, []);

  useEffect(() => {
    const unsubscribe = window.owlAPI.quit.onCheckUnsaved(() => {
      const unsaved = getUnsavedTabs();
      if (unsaved.length === 0) {
        window.owlAPI.quit.respond(true);
        return;
      }
      setState({ phase: 'prompting', queue: unsaved, index: 0 });
    });
    return unsubscribe;
  }, [getUnsavedTabs]);

  const advance = useCallback(
    (prev: Extract<DialogState, { phase: 'prompting' | 'save-failed' }>) => {
      const nextIdx = prev.index + 1;
      if (nextIdx >= prev.queue.length) {
        respond(true);
      } else {
        setState({ phase: 'prompting', queue: prev.queue, index: nextIdx });
      }
    },
    [respond],
  );

  const handleSave = useCallback(async () => {
    if (state.phase !== 'prompting' && state.phase !== 'save-failed') return;
    const tab = state.queue[state.index];
    if (!tab) return;
    setState({ phase: 'saving', queue: state.queue, index: state.index });
    const ok = await requestSaveOrConflict(tab.noteId);
    if (ok) {
      advance({ phase: 'prompting', queue: state.queue, index: state.index });
      return;
    }
    // `ok === false` with conflictPrompt set → AI conflict. Hand off to
    // ConflictDialog: close this modal, cancel the quit, let the user
    // resolve the conflict and retry Cmd+Q manually.
    if (useEditorStore.getState().conflictPrompt !== null) {
      respond(false);
      return;
    }
    // Real save failure (network / daemon down). Offer retry / 不保存 / 取消.
    setState({ phase: 'save-failed', queue: state.queue, index: state.index });
  }, [state, requestSaveOrConflict, advance, respond]);

  const handleSkip = useCallback(() => {
    if (state.phase !== 'prompting' && state.phase !== 'save-failed') return;
    advance(state);
  }, [state, advance]);

  const handleCancel = useCallback(() => {
    respond(false);
  }, [respond]);

  const open = state.phase !== 'idle';
  // Radix Dialog uses onOpenChange to detect "user clicked outside / Esc".
  // Treat that the same as cancel to keep quit behavior consistent.
  const onOpenChange = (next: boolean) => {
    if (!next) handleCancel();
  };

  // Derived values for render; guard when phase === 'idle'.
  const currentTab =
    state.phase === 'prompting' || state.phase === 'saving' || state.phase === 'save-failed'
      ? state.queue[state.index]
      : null;
  const total =
    state.phase === 'prompting' || state.phase === 'saving' || state.phase === 'save-failed'
      ? state.queue.length
      : 0;
  const index =
    state.phase === 'prompting' || state.phase === 'saving' || state.phase === 'save-failed'
      ? state.index
      : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>未保存的更改</DialogTitle>
          <DialogDescription>
            是否保存 <span className="font-medium">"{currentTab?.title ?? ''}"</span> 的更改？
            {total > 1 && (
              <span className="block text-xs text-muted-foreground mt-1">
                第 {index + 1} / {total} 个未保存
              </span>
            )}
            {state.phase === 'save-failed' && (
              <span className="block text-xs text-destructive mt-2">
                保存失败，请稍后重试或选择 "不保存"。
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={handleCancel} disabled={state.phase === 'saving'}>
            取消
          </Button>
          <Button variant="outline" onClick={handleSkip} disabled={state.phase === 'saving'}>
            不保存
          </Button>
          <Button onClick={handleSave} disabled={state.phase === 'saving'}>
            {state.phase === 'saving' ? '保存中…' : state.phase === 'save-failed' ? '重试' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
