import { MarkdownEditor } from '@/components/MarkdownEditor';
import { MarkdownPreview } from '@/components/MarkdownPreview';
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
    <div className="flex h-full min-h-0">
      {/* Note list panel */}
      <div className="w-64 shrink-0 min-h-0">
        <NoteList activeNoteId={activeNoteId} onSelectNote={handleSelectNote} />
      </div>

      {/* Editor + Preview split (temporary for P1-4 testing, replaced by P1-5a) */}
      <div className="flex-1 flex min-h-0 min-w-0">
        {activeNoteId ? (
          <>
            <div className="flex-1 min-w-0 min-h-0 border-r border-border">
              <MarkdownEditor value={content} onChange={setContent} />
            </div>
            <div className="flex-1 min-w-0 min-h-0">
              <MarkdownPreview content={content} />
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full w-full">
            <p className="text-sm text-muted-foreground">选择或新建笔记</p>
          </div>
        )}
      </div>
    </div>
  );
}
