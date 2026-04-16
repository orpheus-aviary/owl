import { useRequestDeleteNote } from '@/components/DeleteConfirmDialog';
import { FolderFilterPopover } from '@/components/FolderFilterPopover';
import { NoteListItem } from '@/components/NoteListItem';
import { TagFilterPopover } from '@/components/TagFilterPopover';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import * as api from '@/lib/api';
import type { NoteTag } from '@/lib/api';
import { type SortKey, useBrowserStore } from '@/stores/browser-store';
import { openNoteById } from '@/stores/editor-store';
import { useFolderStore } from '@/stores/folder-store';
import { ArrowDownAZ, FolderOpen, Search, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const SORT_LABELS: Record<SortKey, string> = {
  updated_desc: '修改时间 ↓',
  updated_asc: '修改时间 ↑',
  created_desc: '创建时间 ↓',
  created_asc: '创建时间 ↑',
};

export function BrowserPage() {
  const {
    query,
    activeTags,
    sortKey,
    folderId,
    notes,
    total,
    loading,
    setQuery,
    addTag,
    removeTag,
    setSortKey,
    setFolderId,
    fetchNotes,
    resetFilters,
  } = useBrowserStore();

  const folderName = useFolderStore((s) => s.folders.find((f) => f.id === folderId)?.name);

  const navigate = useNavigate();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const [searchValue, setSearchValue] = useState(query);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  // Clean up debounce on unmount
  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  // Cmd+R to reset filters
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'r') {
        e.preventDefault();
        setSearchValue('');
        resetFilters();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [resetFilters]);

  const handleSearch = useCallback(
    (value: string) => {
      setSearchValue(value);
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setQuery(value), 300);
    },
    [setQuery],
  );

  const handleClearSearch = useCallback(() => {
    setSearchValue('');
    setQuery('');
  }, [setQuery]);

  const handleToggleTag = useCallback(
    (tag: string) => {
      const current = useBrowserStore.getState().activeTags;
      if (current.includes(tag)) {
        removeTag(tag);
      } else {
        addTag(tag);
      }
    },
    [addTag, removeTag],
  );

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  const handleOpenNote = useCallback(
    (noteId: string) => {
      openNoteById(noteId);
      navigate('/');
    },
    [navigate],
  );

  const requestDelete = useRequestDeleteNote();
  const handleDeleteNote = useCallback(
    async (noteId: string) => {
      await requestDelete(noteId);
      setSelectedNoteId((prev) => (prev === noteId ? null : prev));
    },
    [requestDelete],
  );

  const handleEditTag = useCallback(
    (noteId: string, tag: NoteTag, newValue: string) => {
      const note = notes.find((n) => n.id === noteId);
      if (!note) return;
      api
        .editTagOnNote(note, tag.id, newValue)
        .then(() => fetchNotes())
        .catch(() => {});
    },
    [notes, fetchNotes],
  );

  // Backspace / Delete key to delete selected note
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const id = selectedNoteId;
      if (!id) return;
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (target?.closest('.cm-editor') || target?.isContentEditable) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        e.stopPropagation();
        handleDeleteNote(id);
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [selectedNoteId, handleDeleteNote]);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; noteId: string } | null>(
    null,
  );

  const handleContextMenu = useCallback((e: React.MouseEvent, noteId: string) => {
    e.preventDefault();
    setSelectedNoteId(noteId);
    setContextMenu({ x: e.clientX, y: e.clientY, noteId });
  }, []);

  // Close context menu on any click outside
  useEffect(() => {
    if (!contextMenu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-context-menu]')) return;
      setContextMenu(null);
    };
    document.addEventListener('mousedown', close, true);
    return () => document.removeEventListener('mousedown', close, true);
  }, [contextMenu]);

  // Extract sort field from sortKey (e.g. 'updated_desc' -> 'updated')
  const activeSort = sortKey.startsWith('created') ? ('created' as const) : ('updated' as const);

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="shrink-0 p-3 border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              ref={inputRef}
              placeholder="搜索笔记..."
              value={searchValue}
              onChange={(e) => handleSearch(e.target.value)}
              className="h-8 pl-8 pr-7 text-xs"
            />
            {searchValue && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          {/* Tag filter */}
          <TagFilterPopover activeTags={activeTags} onToggleTag={handleToggleTag} />

          {/* Folder filter */}
          <FolderFilterPopover activeFolderId={folderId} onSelect={setFolderId} />

          {/* Sort */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5 whitespace-nowrap">
                <ArrowDownAZ className="size-3.5" />
                {SORT_LABELS[sortKey]}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(Object.entries(SORT_LABELS) as [SortKey, string][]).map(([key, label]) => (
                <DropdownMenuItem key={key} onClick={() => setSortKey(key)}>
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Active filters */}
        {(activeTags.length > 0 || folderId) && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground">已筛选:</span>
            {folderId && folderName && (
              <Badge variant="secondary" className="gap-1 text-xs px-2 py-0.5">
                <FolderOpen className="size-3" />
                {folderName}
                <button
                  type="button"
                  onClick={() => setFolderId(undefined)}
                  className="hover:text-destructive"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            )}
            {activeTags.map((tag) => (
              <Badge key={tag} variant="secondary" className="gap-1 text-xs px-2 py-0.5">
                #{tag}
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  className="hover:text-destructive"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </div>

      {/* Note list */}
      <ScrollArea className="flex-1 min-h-0">
        {loading && notes.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : notes.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {query || activeTags.length > 0 || folderId ? '无匹配结果' : '暂无笔记'}
          </div>
        ) : (
          <>
            <div className="px-3 py-1.5 text-xs text-muted-foreground">共 {total} 条笔记</div>
            {notes.map((note) => (
              <div key={note.id} onContextMenu={(e) => handleContextMenu(e, note.id)}>
                <NoteListItem
                  note={note}
                  isActive={note.id === selectedNoteId}
                  onClick={() => setSelectedNoteId(note.id)}
                  onDoubleClick={() => handleOpenNote(note.id)}
                  activeSort={activeSort}
                  onEditTag={(tag, newValue) => handleEditTag(note.id, tag, newValue)}
                  draggable
                />
              </div>
            ))}
          </>
        )}
      </ScrollArea>

      {/* Context menu */}
      {contextMenu && (
        <div
          data-context-menu
          className="fixed z-50 min-w-32 rounded-md border border-border bg-popover py-1 shadow-md"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-accent transition-colors"
            onClick={() => {
              const noteId = contextMenu.noteId;
              setContextMenu(null);
              handleDeleteNote(noteId);
            }}
          >
            <Trash2 className="size-3.5" />
            删除
          </button>
        </div>
      )}
    </div>
  );
}
