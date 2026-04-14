import { NoteListItem } from '@/components/NoteListItem';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import * as api from '@/lib/api';
import type { Note } from '@/lib/api';
import { RotateCcw, Search, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Format the time remaining until a note's sticky auto-delete deadline.
 * Returns `null` when the note has no deadline yet (e.g. level-1 trash).
 *
 * - `>= 24h`   → `N 天后清除`
 * - `>= 1h`    → `H 小时 M 分后清除`
 * - `> 0`      → `M 分后清除`
 * - `<= 0`     → `即将清除`
 */
function formatRemaining(autoDeleteAt: string | null): string | null {
  if (!autoDeleteAt) return null;
  const diffMs = new Date(autoDeleteAt).getTime() - Date.now();
  if (diffMs <= 0) return '即将清除';

  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  if (diffMs >= DAY) {
    const days = Math.ceil(diffMs / DAY);
    return `${days} 天后清除`;
  }

  const hours = Math.floor(diffMs / HOUR);
  const mins = Math.floor((diffMs % HOUR) / 60_000);
  if (hours > 0) return `${hours} 小时 ${mins} 分后清除`;
  return `${Math.max(1, mins)} 分后清除`;
}

type TrashTab = 1 | 2;

function emptyMessage(tab: TrashTab, hasQuery: boolean): string {
  if (hasQuery) return '无匹配结果';
  return tab === 1 ? '回收站为空' : '无即将清除的笔记';
}

function TrashNoteRow({
  note,
  tab,
  isSelected,
  onToggle,
  onRestore,
  onDelete,
}: {
  note: Note;
  tab: TrashTab;
  isSelected: boolean;
  onToggle: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const remaining = tab === 2 ? formatRemaining(note.autoDeleteAt) : null;

  return (
    <div className="flex items-start">
      <div className="flex items-center px-2 pt-3">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          className="rounded size-3.5"
        />
      </div>
      <div className="flex-1 min-w-0">
        <NoteListItem note={note} isActive={isSelected} onClick={onToggle} />
      </div>
      <div className="shrink-0 px-2 pt-2 flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="size-7" title="恢复" onClick={onRestore}>
            <RotateCcw className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-destructive hover:text-destructive"
            title={tab === 1 ? '删除' : '永久删除'}
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
        {remaining !== null && (
          <span className="text-xs text-red-500 font-medium whitespace-nowrap">{remaining}</span>
        )}
      </div>
    </div>
  );
}

export function TrashPage() {
  const [tab, setTab] = useState<TrashTab>(1);
  const [notes, setNotes] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [searchValue, setSearchValue] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchNotes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listNotes({
        trash_level: tab,
        q: query || undefined,
        limit: 100,
      });
      setNotes(res.data ?? []);
      setTotal(res.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [tab, query]);

  useEffect(() => {
    fetchNotes();
    setSelectedIds(new Set());
  }, [fetchNotes]);

  // Clean up debounce on unmount
  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  const handleSearch = useCallback((value: string) => {
    setSearchValue(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setQuery(value), 300);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchValue('');
    setQuery('');
  }, []);

  const handleTabChange = useCallback((newTab: TrashTab) => {
    setTab(newTab);
    setSearchValue('');
    setQuery('');
    setSelectedIds(new Set());
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === notes.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(notes.map((n) => n.id)));
    }
  }, [selectedIds.size, notes]);

  // Single-note operations
  const handleRestore = useCallback(
    async (id: string) => {
      await api.restoreNote(id);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      fetchNotes();
    },
    [fetchNotes],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      if (tab === 1) {
        // Move to Tab 2 (increment trash level)
        await api.deleteNote(id);
      } else {
        // Permanent delete
        await api.permanentDeleteNote(id);
      }
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      fetchNotes();
    },
    [tab, fetchNotes],
  );

  // Batch operations
  const handleBatchRestore = useCallback(async () => {
    if (selectedIds.size === 0) return;
    await api.batchRestoreNotes([...selectedIds]);
    setSelectedIds(new Set());
    fetchNotes();
  }, [selectedIds, fetchNotes]);

  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    if (tab === 1) {
      await api.batchDeleteNotes([...selectedIds]);
    } else {
      await api.batchPermanentDeleteNotes([...selectedIds]);
    }
    setSelectedIds(new Set());
    fetchNotes();
  }, [selectedIds, tab, fetchNotes]);

  const allSelected = notes.length > 0 && selectedIds.size === notes.length;

  return (
    <div className="flex flex-col h-full">
      {/* Header: Tabs + Search */}
      <div className="shrink-0 p-3 border-b border-border space-y-2">
        <div className="flex items-center gap-2">
          {/* Tabs */}
          <div className="flex gap-1">
            <Button
              variant={tab === 1 ? 'default' : 'ghost'}
              size="sm"
              className="h-8"
              onClick={() => handleTabChange(1)}
            >
              回收站
            </Button>
            <Button
              variant={tab === 2 ? 'default' : 'ghost'}
              size="sm"
              className="h-8"
              onClick={() => handleTabChange(2)}
            >
              即将清除
            </Button>
          </div>

          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
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
        </div>
      </div>

      {/* Toolbar — aligned with note rows */}
      <div className="shrink-0 flex items-center gap-2 py-1.5 border-b border-border pr-3">
        <label className="flex items-center text-sm cursor-pointer pl-2">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleSelectAll}
            className="rounded size-3.5"
          />
          <span className="ml-[18px]">全选</span>
        </label>

        <div
          className={
            selectedIds.size > 0 ? 'flex items-center gap-2' : 'invisible flex items-center gap-2'
          }
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={handleBatchRestore}
          >
            <RotateCcw className="size-3" />
            恢复
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs text-destructive hover:text-destructive"
            onClick={handleBatchDelete}
          >
            <Trash2 className="size-3" />
            {tab === 1 ? '删除' : '永久删除'}
          </Button>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            已选 {selectedIds.size}
          </Badge>
        </div>

        <span className="ml-auto text-xs text-muted-foreground">共 {total} 条</span>
      </div>

      {/* Note list */}
      <ScrollArea className="flex-1 min-h-0">
        {loading && notes.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : notes.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {emptyMessage(tab, !!query)}
          </div>
        ) : (
          notes.map((note) => (
            <TrashNoteRow
              key={note.id}
              note={note}
              tab={tab}
              isSelected={selectedIds.has(note.id)}
              onToggle={() => toggleSelect(note.id)}
              onRestore={() => handleRestore(note.id)}
              onDelete={() => handleDelete(note.id)}
            />
          ))
        )}
      </ScrollArea>
    </div>
  );
}
