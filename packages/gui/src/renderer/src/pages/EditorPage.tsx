import { EditorPanel } from '@/components/EditorPanel';
import { NoteList } from '@/components/NoteList';
import { TabBar } from '@/components/TabBar';
import { openNoteById, useEditorStore } from '@/stores/editor-store';
import { useCallback } from 'react';

export function EditorPage() {
  const activeTabId = useEditorStore((s) => s.activeTabId);

  const handleSelectNote = useCallback((noteId: string) => {
    openNoteById(noteId);
  }, []);

  return (
    <div className="flex h-full min-h-0">
      {/* Note list panel */}
      <div className="w-64 shrink-0 min-h-0">
        <NoteList activeNoteId={activeTabId} onSelectNote={handleSelectNote} />
      </div>

      {/* Editor area */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        <TabBar />
        <EditorPanel />
      </div>
    </div>
  );
}
