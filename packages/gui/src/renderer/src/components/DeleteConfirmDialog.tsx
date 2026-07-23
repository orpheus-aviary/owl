import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useOpenNote } from '@/hooks/useOpenNote';
import * as api from '@/lib/api';
import { SPECIAL_NOTE_ID_SET } from '@/lib/special-notes';
import { useDataBus } from '@/stores/data-bus';
import { useEditorStore } from '@/stores/editor-store';
import { currentGen, isStale } from '@/stores/session-epoch';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { create } from 'zustand';

/**
 * Unified note-delete flow (delete-by-source, §4.1.4):
 * - Clean (or not open in any tab) → delete API + close tab if open + refresh
 *   list, staying on the source page (Browser stays Browser).
 * - Dirty tab exists → open the note through `useOpenNote` (desktop = editor
 *   tab + navigate('/'); mobile = /note/:id detail with canPop/returnTo) so the
 *   user sees the unsaved changes, then the confirm dialog; a confirmed delete
 *   replaces to '/' so back can't return to the deleted note.
 *
 * The "save then delete" path is intentionally not offered — saving a note
 * just to immediately move it to trash is a confusing UX. Users who want to
 * preserve their edits can cancel, save manually, then delete again.
 */

interface PendingDeleteState {
  /** Non-null when a confirm / protected dialog is showing. */
  noteId: string | null;
  title: string;
  /** 'confirm' → regular dirty-tab confirm; 'protected' → system-note info. */
  kind: 'confirm' | 'protected';
  open: (noteId: string, title: string) => void;
  openProtected: (title: string) => void;
  reset: () => void;
}

export const usePendingDeleteStore = create<PendingDeleteState>((set) => ({
  noteId: null,
  title: '',
  kind: 'confirm',
  open: (noteId, title) => set({ noteId, title, kind: 'confirm' }),
  openProtected: (title) => set({ noteId: 'protected', title, kind: 'protected' }),
  reset: () => set({ noteId: null, title: '', kind: 'confirm' }),
}));

/** Actually delete the note via API + close its tab if open + bump the
 *  data-bus so every list (note-store, browser-store, folder-panel notes,
 *  trash-page) refreshes through their bus subscriptions. */
async function performDelete(noteId: string): Promise<void> {
  const gen = currentGen();
  await api.deleteNote(noteId);
  if (isStale(gen)) return; // session switched mid-delete → don't touch new session
  const editor = useEditorStore.getState();
  if (editor.tabs.some((t) => t.noteId === noteId)) {
    editor.closeTab(noteId);
  }
  useDataBus.getState().bumpNotes();
}

/**
 * Returns a callback that requests deletion of a note, following the
 * unified flow above. Must be called from inside a Router context
 * (uses `useNavigate` for the dirty-jump case).
 */
export function useRequestDeleteNote(): (noteId: string) => Promise<void> {
  const openNote = useOpenNote();
  const openDialog = usePendingDeleteStore((s) => s.open);
  const openProtected = usePendingDeleteStore((s) => s.openProtected);

  return useCallback(
    async (noteId: string) => {
      // Short-circuit for system-managed notes — daemon also guards with
      // 403, but surfacing a clear dialog up-front beats a silent failure
      // or a confusing HTTP error toast.
      if (SPECIAL_NOTE_ID_SET.has(noteId)) {
        const editor = useEditorStore.getState();
        const tab = editor.tabs.find((t) => t.noteId === noteId);
        openProtected(tab?.title ?? '系统笔记');
        return;
      }

      const editor = useEditorStore.getState();
      const tab = editor.tabs.find((t) => t.noteId === noteId);

      if (tab?.dirty) {
        // Open the dirty note so the user sees what they'd lose, then confirm.
        // Only surface the dialog once the open committed (mobile may prompt a
        // save/discard on a different dirty note first, or the user may cancel).
        const outcome = await openNote({ noteId });
        if (outcome === 'opened') openDialog(noteId, tab.title);
        return;
      }

      await performDelete(noteId);
    },
    [openNote, openDialog, openProtected],
  );
}

/** The actual confirm dialog. Mount once at the App level. */
export function DeleteConfirmDialog() {
  const { noteId, title, kind, reset } = usePendingDeleteStore();
  const navigate = useNavigate();
  const open = noteId !== null;

  const onConfirm = useCallback(async () => {
    if (!noteId) return;
    await performDelete(noteId);
    reset();
    // The dirty-delete flow opened the note first; after deleting, leave that
    // detail so a mobile back can't return to the now-deleted note. On desktop
    // we're already at '/', so this is a no-op.
    navigate('/', { replace: true });
  }, [noteId, reset, navigate]);

  if (kind === 'protected') {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && reset()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>系统笔记无法删除</DialogTitle>
            <DialogDescription>
              「{title}
              」是系统内置的笔记（如 #随记 /
              #待办），不能移入回收站或永久删除。你可以自由编辑它的内容和标签。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={reset}>知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && reset()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>删除未保存的笔记？</DialogTitle>
          <DialogDescription>
            「{title}
            」有未保存的修改。删除会将笔记移入回收站，内存中的未保存改动将丢失（笔记本身可从回收站恢复）。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={reset}>
            取消
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            放弃修改并删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
