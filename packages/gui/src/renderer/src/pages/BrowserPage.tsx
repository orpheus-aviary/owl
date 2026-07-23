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
import { useIsMobile } from '@/hooks/useIsMobile';
import { useOpenNote } from '@/hooks/useOpenNote';
import * as api from '@/lib/api';
import type { Note, NoteTag } from '@/lib/api';
import { cn } from '@/lib/utils';
import { type SortKey, useBrowserStore } from '@/stores/browser-store';
import { useDataBus } from '@/stores/data-bus';
import { useFolderStore } from '@/stores/folder-store';
import { currentGen, isStale } from '@/stores/session-epoch';
import { ArrowDownAZ, FolderOpen, Pin, PinOff, Search, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

const SORT_LABELS: Record<SortKey, string> = {
  updated_desc: '修改时间 ↓',
  updated_asc: '修改时间 ↑',
  created_desc: '创建时间 ↓',
  created_asc: '创建时间 ↑',
};

/** Tag / folder / sort triggers. Mobile lays them out as an even 3-col grid so
 *  they always fit one row and never wrap off; desktop keeps them inline (the
 *  wrapper is `contents`, so byte-identical when !isMobile). */
function FilterSortButtons({
  activeTags,
  onToggleTag,
  folderId,
  onSelectFolder,
  sortKey,
  onSortKey,
  isMobile,
}: {
  activeTags: string[];
  onToggleTag: (tag: string) => void;
  folderId: string | undefined;
  onSelectFolder: (id: string | undefined) => void;
  sortKey: SortKey;
  onSortKey: (key: SortKey) => void;
  isMobile: boolean;
}) {
  const triggerCls = isMobile ? 'w-full min-w-0' : undefined;
  return (
    <div className={cn(isMobile ? 'grid grid-cols-3 gap-2' : 'contents')}>
      <TagFilterPopover activeTags={activeTags} onToggleTag={onToggleTag} className={triggerCls} />

      <FolderFilterPopover
        activeFolderId={folderId}
        onSelect={onSelectFolder}
        className={triggerCls}
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn('h-8 gap-1.5 whitespace-nowrap', triggerCls)}
          >
            <ArrowDownAZ className="size-3.5 shrink-0" />
            <span className="truncate min-w-0">{SORT_LABELS[sortKey]}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {(Object.entries(SORT_LABELS) as [SortKey, string][]).map(([key, label]) => (
            <DropdownMenuItem key={key} onClick={() => onSortKey(key)}>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

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

  const openNote = useOpenNote();
  const isMobile = useIsMobile();
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
      // Desktop = openNoteById + navigate('/'); mobile routes to /note/:id.
      void openNote({ noteId });
    },
    [openNote],
  );

  // Desktop: single-click selects, double-click opens. Mobile (touch): a single
  // tap opens — there's no hover/double-tap idiom, and 浏览 is the primary way
  // to reach a note now.
  const handleRowClick = useCallback(
    (noteId: string) => {
      if (isMobile) handleOpenNote(noteId);
      else setSelectedNoteId(noteId);
    },
    [isMobile, handleOpenNote],
  );

  const requestDelete = useRequestDeleteNote();
  const handleDeleteNote = useCallback(
    async (noteId: string) => {
      await requestDelete(noteId);
      setSelectedNoteId((prev) => (prev === noteId ? null : prev));
    },
    [requestDelete],
  );

  const handleTogglePin = useCallback(async (noteId: string, pinned: boolean) => {
    const gen = currentGen();
    try {
      await api.pinNote(noteId, pinned);
      if (isStale(gen)) return;
      useDataBus.getState().bumpNotes();
    } catch (err) {
      console.error('pin toggle failed', err);
    }
  }, []);

  const handleEditTag = useCallback(
    (noteId: string, tag: NoteTag, newValue: string) => {
      const note = notes.find((n) => n.id === noteId);
      if (!note) return;
      // ③ (附录 A): don't refetch into the next session if a switch lands
      // between the tag edit and its completion.
      const gen = currentGen();
      api
        .editTagOnNote(note, tag.id, newValue)
        .then(() => {
          if (isStale(gen)) return;
          fetchNotes();
        })
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
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

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
      {/* Action bar. Mobile stacks it into two rows — search on top, the three
          filter/sort buttons below — so the narrow width doesn't cramp them;
          desktop keeps the single inline row (byte-identical when !isMobile). */}
      <div className="shrink-0 p-3 border-b border-border space-y-2">
        <div className={cn(isMobile ? 'space-y-2' : 'flex items-center gap-2')}>
          {/* Search */}
          <div className={cn('relative', isMobile ? 'w-full' : 'flex-1')}>
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

          <FilterSortButtons
            activeTags={activeTags}
            onToggleTag={handleToggleTag}
            folderId={folderId}
            onSelectFolder={setFolderId}
            sortKey={sortKey}
            onSortKey={setSortKey}
            isMobile={isMobile}
          />
        </div>

        <ActiveFilters
          activeTags={activeTags}
          folderId={folderId}
          folderName={folderName}
          onRemoveTag={removeTag}
          onClearFolder={() => setFolderId(undefined)}
        />
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
                  onClick={() => handleRowClick(note.id)}
                  onDoubleClick={() => handleOpenNote(note.id)}
                  activeSort={activeSort}
                  onEditTag={(tag, newValue) => handleEditTag(note.id, tag, newValue)}
                  // Desktop drags notes into the folder tree; mobile 浏览 has no
                  // such target (folders live on their own page) — so a touch
                  // long-press should surface the context menu, not start a drag.
                  draggable={!isMobile}
                />
              </div>
            ))}
          </>
        )}
      </ScrollArea>

      {/* Context menu */}
      {contextMenu && (
        <BrowserContextMenu
          menu={contextMenu}
          notes={notes}
          onTogglePin={handleTogglePin}
          onDelete={handleDeleteNote}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

/** The "已筛选" chip row (active folder + tags). Pulled out of BrowserPage so
 *  its render stays under the cognitive-complexity cap; renders nothing when no
 *  filter is active. */
function ActiveFilters({
  activeTags,
  folderId,
  folderName,
  onRemoveTag,
  onClearFolder,
}: {
  activeTags: string[];
  folderId: string | undefined;
  folderName: string | undefined;
  onRemoveTag: (tag: string) => void;
  onClearFolder: () => void;
}) {
  if (activeTags.length === 0 && !folderId) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-muted-foreground">已筛选:</span>
      {folderId && folderName && (
        <Badge variant="secondary" className="gap-1 text-xs px-2 py-0.5">
          <FolderOpen className="size-3" />
          {folderName}
          <button type="button" onClick={onClearFolder} className="hover:text-destructive">
            <X className="size-3" />
          </button>
        </Badge>
      )}
      {activeTags.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 text-xs px-2 py-0.5">
          #{tag}
          <button type="button" onClick={() => onRemoveTag(tag)} className="hover:text-destructive">
            <X className="size-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}

interface ContextMenuState {
  x: number;
  y: number;
  noteId: string;
}

/** Right-click / long-press note context menu (置顶 / 删除). Pulled out of
 *  BrowserPage so its render stays under the cognitive-complexity cap. */
function BrowserContextMenu({
  menu,
  notes,
  onTogglePin,
  onDelete,
  onClose,
}: {
  menu: ContextMenuState;
  notes: Note[];
  onTogglePin: (noteId: string, pinned: boolean) => void;
  onDelete: (noteId: string) => void;
  onClose: () => void;
}) {
  const isPinned = notes.find((n) => n.id === menu.noteId)?.pinnedAt != null;
  return (
    <div
      data-context-menu
      className="fixed z-50 min-w-32 rounded-md border border-border bg-popover py-1 shadow-md"
      style={{ left: menu.x, top: menu.y }}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
        onClick={() => {
          onClose();
          onTogglePin(menu.noteId, !isPinned);
        }}
      >
        {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
        {isPinned ? '取消置顶' : '置顶'}
      </button>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-accent transition-colors"
        onClick={() => {
          onClose();
          onDelete(menu.noteId);
        }}
      >
        <Trash2 className="size-3.5" />
        删除
      </button>
    </div>
  );
}
