import { NoteList } from '@/components/NoteList';
import { useCallback, useState } from 'react';

export function EditorPage() {
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);

  const handleSelectNote = useCallback((noteId: string) => {
    setActiveNoteId(noteId);
  }, []);

  return (
    <div className="flex h-full">
      {/* Note list panel */}
      <div className="w-64 shrink-0">
        <NoteList activeNoteId={activeNoteId} onSelectNote={handleSelectNote} />
      </div>

      {/* Editor area — placeholder for P1-3+ */}
      <div className="flex-1 flex items-center justify-center">
        {activeNoteId ? (
          <p className="text-sm text-muted-foreground">编辑器（P1-3 实现）— {activeNoteId}</p>
        ) : (
          <p className="text-sm text-muted-foreground">选择或新建笔记</p>
        )}
      </div>
    </div>
  );
}
