import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import * as api from '@/lib/api';
import { useEditorStore } from '@/stores/editor-store';
import { useNoteStore } from '@/stores/note-store';
import { Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NoteListItem } from './NoteListItem';

interface NoteListProps {
  activeNoteId: string | null;
  onSelectNote: (noteId: string) => void;
}

export function NoteList({ activeNoteId, onSelectNote }: NoteListProps) {
  const { notes, query, loading, fetchNotes, setQuery, createNote } = useNoteStore();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  const handleSearch = useCallback(
    (value: string) => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setQuery(value), 300);
    },
    [setQuery],
  );

  const handleCreate = useCallback(async () => {
    const note = await createNote();
    if (note) onSelectNote(note.id);
  }, [createNote, onSelectNote]);

  const handleDelete = useCallback(
    async (noteId: string) => {
      await api.deleteNote(noteId);
      // Close the tab if this note is open in editor
      const editorState = useEditorStore.getState();
      if (editorState.tabs.some((t) => t.noteId === noteId)) {
        editorState.closeTab(noteId);
      }
      if (selectedId === noteId) setSelectedId(null);
      fetchNotes();
    },
    [selectedId, fetchNotes],
  );

  // Keyboard delete for selected note
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!selectedId) return;
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (target?.closest('.cm-editor') || target?.isContentEditable) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        e.stopPropagation();
        handleDelete(selectedId);
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [selectedId, handleDelete]);

  // Auto-scroll to the active note when tab switches
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeNoteId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-note-id="${activeNoteId}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [activeNoteId]);

  // The visually active note is the one open in editor OR the selected one
  const displayActiveId = activeNoteId ?? selectedId;

  return (
    <div className="flex flex-col h-full min-h-0 border-r border-border">
      {/* Header: new + search */}
      <div className="flex items-center gap-1 p-2 border-b border-border">
        <Button variant="ghost" size="icon" className="shrink-0 size-8" onClick={handleCreate}>
          <Plus className="size-4" />
        </Button>
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            placeholder="搜索笔记..."
            defaultValue={query}
            onChange={(e) => handleSearch(e.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
      </div>

      {/* List */}
      <ScrollArea className="flex-1 min-h-0">
        <div ref={listRef}>
          {loading && notes.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">加载中...</div>
          ) : notes.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              {query ? '无搜索结果' : '暂无笔记'}
            </div>
          ) : (
            notes.map((note) => (
              <div key={note.id} data-note-id={note.id}>
                <NoteListItem
                  note={note}
                  isActive={note.id === displayActiveId}
                  onClick={() => setSelectedId(note.id)}
                  onDoubleClick={() => onSelectNote(note.id)}
                />
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
