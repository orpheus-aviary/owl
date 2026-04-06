import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useNoteStore } from '@/stores/note-store';
import { Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { NoteListItem } from './NoteListItem';

interface NoteListProps {
  activeNoteId: string | null;
  onSelectNote: (noteId: string) => void;
}

export function NoteList({ activeNoteId, onSelectNote }: NoteListProps) {
  const { notes, query, loading, fetchNotes, setQuery, createNote } = useNoteStore();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

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

  return (
    <div className="flex flex-col h-full border-r border-border">
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
      <ScrollArea className="flex-1">
        {loading && notes.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">加载中...</div>
        ) : notes.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            {query ? '无搜索结果' : '暂无笔记'}
          </div>
        ) : (
          notes.map((note) => (
            <NoteListItem
              key={note.id}
              note={note}
              isActive={note.id === activeNoteId}
              onClick={() => onSelectNote(note.id)}
            />
          ))
        )}
      </ScrollArea>
    </div>
  );
}
