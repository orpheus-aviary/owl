import { EditorPanel } from '@/components/EditorPanel';
import { NoteList } from '@/components/NoteList';
import { TabBar } from '@/components/TabBar';
import { type UnsavedAction, UnsavedDialog } from '@/components/UnsavedDialog';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { useEditorShortcuts } from '@/hooks/useEditorShortcuts';
import { openNoteById, useEditorStore } from '@/stores/editor-store';
import { useCallback, useRef, useState } from 'react';
import { Group, Panel, useDefaultLayout } from 'react-resizable-panels';

export function EditorPage() {
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false);
  const pendingCloseId = useRef<string | null>(null);
  const pendingCloseTitle = useRef('');

  const layout = useDefaultLayout({
    id: 'owl-editor-layout',
    storage: typeof window === 'undefined' ? undefined : window.localStorage,
  });

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

  const handleSelectNote = useCallback((noteId: string) => {
    openNoteById(noteId);
  }, []);

  useEditorShortcuts({ requestCloseTab });

  return (
    <>
      <Group
        orientation="horizontal"
        id="owl-editor-layout"
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="flex h-full min-h-0"
      >
        <Panel
          id="note-list"
          defaultSize={22}
          minSize={15}
          className="flex min-w-0 border-r border-border"
        >
          <NoteList activeNoteId={activeTabId} onSelectNote={handleSelectNote} />
        </Panel>
        <ResizeHandle />
        <Panel id="editor-area" defaultSize={78} minSize={50} className="flex min-w-0">
          <div className="flex-1 flex flex-col min-h-0 min-w-0">
            <TabBar onCloseTab={requestCloseTab} />
            <EditorPanel />
          </div>
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
