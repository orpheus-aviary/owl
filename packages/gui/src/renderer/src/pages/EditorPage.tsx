import { MarkdownEditor } from '@/components/MarkdownEditor';
import { NoteList } from '@/components/NoteList';
import * as api from '@/lib/api';
import { useCallback, useEffect, useState } from 'react';

export function EditorPage() {
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [content, setContent] = useState('');

  const handleSelectNote = useCallback((noteId: string) => {
    setActiveNoteId(noteId);
  }, []);

  // Load note content when active note changes
  useEffect(() => {
    if (!activeNoteId) {
      setContent('');
      return;
    }
    api.getNote(activeNoteId).then((res) => {
      if (res.data) setContent(res.data.content);
    });
  }, [activeNoteId]);

  return (
    <div className="flex h-full">
      {/* Note list panel */}
      <div className="w-64 shrink-0">
        <NoteList activeNoteId={activeNoteId} onSelectNote={handleSelectNote} />
      </div>

      {/* Editor area */}
      <div className="flex-1">
        {activeNoteId ? (
          <MarkdownEditor value={content} onChange={setContent} />
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">选择或新建笔记</p>
          </div>
        )}
      </div>
    </div>
  );
}
