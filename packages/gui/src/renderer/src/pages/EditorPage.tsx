import { EditorPanel } from '@/components/EditorPanel';
import { NoteList } from '@/components/NoteList';
import { TabBar } from '@/components/TabBar';
import { type UnsavedAction, UnsavedDialog } from '@/components/UnsavedDialog';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { useEditorShortcuts } from '@/hooks/useEditorShortcuts';
import { useOwlLayout } from '@/hooks/useOwlLayout';
import type { Note } from '@/lib/api';
import { LAYOUT_KEYS } from '@/lib/layout-keys';
import { useEditorStore } from '@/stores/editor-store';
import { useCallback, useRef, useState } from 'react';
import { Group, Panel } from 'react-resizable-panels';

export function EditorPage() {
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false);
  const pendingCloseId = useRef<string | null>(null);
  const pendingCloseTitle = useRef('');

  const layout = useOwlLayout(LAYOUT_KEYS.editorLayout);

  const requestCloseTab = useCallback((noteId: string) => {
    const tab = useEditorStore.getState().tabs.find((t) => t.noteId === noteId);
    if (!tab) return;
    if (tab.dirty) {
      pendingCloseId.current = noteId;
      pendingCloseTitle.current = tab.title;
      setUnsavedDialogOpen(true);
    } else {
      useEditorStore.getState().closeTab(noteId);
    }
  }, []);

  const handleUnsavedAction = useCallback(async (action: UnsavedAction) => {
    const noteId = pendingCloseId.current;
    setUnsavedDialogOpen(false);
    if (!noteId) return;

    if (action === 'save') {
      const ok = await useEditorStore.getState().saveNote(noteId);
      if (ok) useEditorStore.getState().closeTab(noteId);
    } else if (action === 'discard') {
      useEditorStore.getState().closeTab(noteId);
    }
    // 'cancel' — do nothing
    pendingCloseId.current = null;
  }, []);

  // NoteList hands over the fully-loaded `Note` (already in `useNoteStore`)
  // so we open synchronously — no `openNoteById` fetch that could race a
  // rapid click sequence and drop the user on a stale preview. opts decide
  // preview vs pinned tab (P3.4-e).
  const handleSelectNote = useCallback((note: Note, opts?: { preview?: boolean }) => {
    useEditorStore.getState().openNote(note, opts);
  }, []);

  useEditorShortcuts({ requestCloseTab });

  return (
    <>
      <Group
        orientation="horizontal"
        id={LAYOUT_KEYS.editorLayout}
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="flex h-full min-h-0"
      >
        <Panel
          id="note-list"
          defaultSize="22%"
          minSize="120px"
          className="h-full w-full min-h-0 min-w-0 border-r border-border"
        >
          <NoteList activeNoteId={activeTabId} onSelectNote={handleSelectNote} />
        </Panel>
        <ResizeHandle />
        <Panel
          id="editor-area"
          defaultSize="78%"
          minSize="400px"
          className="flex h-full w-full min-h-0 min-w-0 flex-col"
        >
          <TabBar onCloseTab={requestCloseTab} />
          <EditorPanel />
        </Panel>
      </Group>
      <UnsavedDialog
        open={unsavedDialogOpen}
        title={pendingCloseTitle.current}
        onAction={handleUnsavedAction}
      />
    </>
  );
}
