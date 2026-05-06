import { useRequestDeleteNote } from '@/components/DeleteConfirmDialog';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import * as api from '@/lib/api';
import type { Note } from '@/lib/api';
import { useDataBus } from '@/stores/data-bus';
import { useNoteStore } from '@/stores/note-store';
import { Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NoteListItem } from './NoteListItem';

// Pulled out of NoteList to keep its cognitive complexity under Biome's cap —
// the arrow-key handler otherwise folds in three branches (no-anchor / down /
// up) on top of guards. Anchor not found (e.g. after a search collapses the
// list) falls back to index 0; wrap is clamped, not cyclic.
function computeNextNoteIdx(
  notes: readonly { id: string }[],
  anchorId: string | null,
  delta: 1 | -1,
): number {
  const anchorIdx = anchorId ? notes.findIndex((n) => n.id === anchorId) : -1;
  if (anchorIdx === -1) return 0;
  const raw = anchorIdx + delta;
  return Math.min(Math.max(raw, 0), notes.length - 1);
}

interface NoteListProps {
  activeNoteId: string | null;
  /**
   * Called when the user selects a note from the list. Opts decide preview vs
   * pinned tab behavior (P3.4-e):
   *   - single-click / ArrowUp / ArrowDown → `{ preview: true }`
   *   - double-click → `{ preview: false }`
   * The full `Note` object (already in `useNoteStore`) is passed through so
   * the consumer can open synchronously without refetching — quick clicks
   * won't race a stale fetch into the preview slot.
   */
  onSelectNote: (note: Note, opts?: { preview?: boolean }) => void;
}

export function NoteList({ activeNoteId, onSelectNote }: NoteListProps) {
  const { notes, query, loading, fetchNotes, setQuery, createNote } = useNoteStore();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);

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
    if (note) onSelectNote(note, { preview: false });
  }, [createNote, onSelectNote]);

  const requestDelete = useRequestDeleteNote();
  const handleDelete = useCallback(
    async (noteId: string) => {
      await requestDelete(noteId);
      if (selectedId === noteId) setSelectedId(null);
    },
    [selectedId, requestDelete],
  );

  const handleTogglePin = useCallback(async (noteId: string, pinned: boolean) => {
    try {
      await api.pinNote(noteId, pinned);
      useDataBus.getState().bumpNotes();
    } catch (err) {
      console.error('pin toggle failed', err);
    }
  }, []);

  // Single-click: select + open preview tab. Keeping the Note object local
  // (not the id) lets `onSelectNote` hand the fresh snapshot to `openNote`
  // synchronously — no intermediate fetch that could arrive out of order.
  const handleItemClick = useCallback(
    (note: Note) => {
      setSelectedId(note.id);
      onSelectNote(note, { preview: true });
    },
    [onSelectNote],
  );

  const handleItemDoubleClick = useCallback(
    (note: Note) => {
      onSelectNote(note, { preview: false });
    },
    [onSelectNote],
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

  // ArrowUp / ArrowDown cycle through the filtered note list and open each
  // one as a preview. Bound to the list container only (not document) so
  // other pages / TagBar picker / editor keybindings stay untouched. The
  // `INPUT` guard exempts the search box above, where arrow keys should
  // retain their default text-navigation meaning.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const target = e.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      if (notes.length === 0) return;
      e.preventDefault();
      e.stopPropagation();

      const anchorId = selectedId ?? activeNoteId;
      const nextIdx = computeNextNoteIdx(notes, anchorId, e.key === 'ArrowDown' ? 1 : -1);
      const next = notes[nextIdx];
      if (!next) return;
      setSelectedId(next.id);
      onSelectNote(next, { preview: true });
      // Scroll the targeted row into view. `scrollIntoView({block:'nearest'})`
      // already fires via the activeNoteId effect above, but that only kicks
      // in after the store updates; do it here too for responsiveness.
      const el = listRef.current?.querySelector(`[data-note-id="${next.id}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    },
    [notes, selectedId, activeNoteId, onSelectNote],
  );

  return (
    <div className="flex flex-col h-full w-full min-h-0 min-w-0">
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

      {/* List — keydown is bound here (not document) so ArrowUp/Down can't
          leak into the editor or other pages. tabIndex={0} makes the list
          container itself the single keyboard entry point; individual items
          pass tabIndex={-1} to avoid a multi-stop form rhythm. */}
      <div
        ref={listContainerRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: container is the sole keyboard entry point for this list (see P3.4-e §4.4).
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="flex-1 min-h-0 outline-none"
      >
        <ScrollArea className="h-full">
          <div ref={listRef}>
            {loading && notes.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">加载中...</div>
            ) : notes.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                {query ? '无搜索结果' : '暂无笔记'}
              </div>
            ) : (
              notes.map((note) => (
                <ContextMenu key={note.id}>
                  <ContextMenuTrigger asChild>
                    <div data-note-id={note.id}>
                      <NoteListItem
                        note={note}
                        isActive={note.id === displayActiveId}
                        onClick={() => handleItemClick(note)}
                        onDoubleClick={() => handleItemDoubleClick(note)}
                        tabIndex={-1}
                      />
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      onClick={() => handleTogglePin(note.id, note.pinnedAt == null)}
                    >
                      {note.pinnedAt == null ? (
                        <>
                          <Pin className="size-3.5" />
                          置顶
                        </>
                      ) : (
                        <>
                          <PinOff className="size-3.5" />
                          取消置顶
                        </>
                      )}
                    </ContextMenuItem>
                    <ContextMenuItem variant="destructive" onClick={() => handleDelete(note.id)}>
                      <Trash2 className="size-3.5" />
                      删除
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
