import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import * as api from '@/lib/api';
import { useBrowserStore } from '@/stores/browser-store';
import { useEditorStore } from '@/stores/editor-store';
import { useFolderStore } from '@/stores/folder-store';
import { useNoteStore } from '@/stores/note-store';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { create } from 'zustand';

/**
 * Unified note-delete flow:
 * - Clean (or not open in any tab) → delete API + close tab if open + refresh list
 * - Dirty tab exists → navigate to editor, activate the tab, open confirm dialog
 *   so the user can see the unsaved changes before choosing to discard them.
 *
 * The "save then delete" path is intentionally not offered — saving a note
 * just to immediately move it to trash is a confusing UX. Users who want to
 * preserve their edits can cancel, save manually, then delete again.
 */

interface PendingDeleteState {
  noteId: string | null;
  title: string;
  open: (noteId: string, title: string) => void;
  reset: () => void;
}

export const usePendingDeleteStore = create<PendingDeleteState>((set) => ({
  noteId: null,
  title: '',
  open: (noteId, title) => set({ noteId, title }),
  reset: () => set({ noteId: null, title: '' }),
}));

/** Actually delete the note via API + close its tab if open + refresh both
 *  note stores. Editor-page list reads from noteStore, browser-page list
 *  reads from browserStore (with search/tag/sort state) — refresh both so
 *  whichever page the user is on reflects the deletion immediately. */
async function performDelete(noteId: string): Promise<void> {
  await api.deleteNote(noteId);
  const editor = useEditorStore.getState();
  if (editor.tabs.some((t) => t.noteId === noteId)) {
    editor.closeTab(noteId);
  }
  useNoteStore.getState().fetchNotes();
  useBrowserStore.getState().fetchNotes();
  useFolderStore.getState().fetchPanelNotes();
}

/**
 * Returns a callback that requests deletion of a note, following the
 * unified flow above. Must be called from inside a Router context
 * (uses `useNavigate` for the dirty-jump case).
 */
export function useRequestDeleteNote(): (noteId: string) => Promise<void> {
  const navigate = useNavigate();
  const openDialog = usePendingDeleteStore((s) => s.open);

  return useCallback(
    async (noteId: string) => {
      const editor = useEditorStore.getState();
      const tab = editor.tabs.find((t) => t.noteId === noteId);

      if (tab?.dirty) {
        // Jump to the dirty tab so the user sees what they'd lose.
        editor.setActiveTab(noteId);
        navigate('/');
        openDialog(noteId, tab.title);
        return;
      }

      await performDelete(noteId);
    },
    [navigate, openDialog],
  );
}

/** The actual confirm dialog. Mount once at the App level. */
export function DeleteConfirmDialog() {
  const { noteId, title, reset } = usePendingDeleteStore();
  const open = noteId !== null;

  const onConfirm = useCallback(async () => {
    if (!noteId) return;
    await performDelete(noteId);
    reset();
  }, [noteId, reset]);

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
