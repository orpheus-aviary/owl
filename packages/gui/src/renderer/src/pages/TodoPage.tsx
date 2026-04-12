import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import * as api from '@/lib/api';
import type { TodoGroup, TodoItem } from '@/lib/api';
import {
  extractTitle as parseTitle,
  parseTodosFromContent,
  toggleTodoLine,
} from '@/lib/todo-parser';
import { openNoteById, useEditorStore } from '@/stores/editor-store';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

type TodoFilter = 'open' | 'all';

/** Merge daemon results with dirty editor tab overlays.
 *
 *  The todo page's data source is daemon /todos + whatever is currently in
 *  dirty editor tabs. When a note is open with unsaved changes, the daemon's
 *  view is stale, so we re-parse the tab's content directly. See §3.4.1 of
 *  the P2 design doc.
 */
function mergeWithDirtyTabs(
  remote: TodoGroup[],
  dirtyTabs: { noteId: string; content: string; dirty: boolean }[],
  filter: TodoFilter,
): (TodoGroup & { hasUnsaved?: boolean })[] {
  const merged = new Map<string, TodoGroup & { hasUnsaved?: boolean }>();
  for (const g of remote) merged.set(g.note_id, { ...g });

  for (const tab of dirtyTabs) {
    if (!tab.dirty) continue;
    const localItems = parseTodosFromContent(tab.content);
    const filtered = filter === 'open' ? localItems.filter((it) => !it.checked) : localItems;

    if (filtered.length === 0) {
      merged.delete(tab.noteId);
      continue;
    }

    merged.set(tab.noteId, {
      note_id: tab.noteId,
      note_title: parseTitle(tab.content),
      // Local dirty edits are newer than anything daemon reports.
      updated_at: new Date().toISOString(),
      items: localItems,
      hasUnsaved: true,
    });
  }

  return Array.from(merged.values()).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function TodoGroupRow({
  group,
  filter,
  onToggle,
  onOpen,
  expanded,
  onToggleExpand,
}: {
  group: TodoGroup & { hasUnsaved?: boolean };
  filter: TodoFilter;
  onToggle: (item: TodoItem) => void;
  onOpen: () => void;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const visible = filter === 'open' ? group.items.filter((it) => !it.checked) : group.items;
  const openCount = group.items.filter((it) => !it.checked).length;

  if (visible.length === 0) return null;

  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={onToggleExpand}
        className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-accent/50 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
        <button
          type="button"
          className="text-sm font-medium truncate hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {group.note_title}
        </button>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {group.hasUnsaved && (
            <Badge variant="outline" className="text-xs h-5 text-amber-500 border-amber-500/40">
              ●未保存
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {openCount}/{group.items.length}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="pb-2">
          {visible.map((item) => (
            <label
              key={item.line}
              className="flex items-start gap-2 px-8 py-1.5 hover:bg-accent/30 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={item.checked}
                onChange={() => onToggle(item)}
                className="mt-0.5 size-4 shrink-0 cursor-pointer"
              />
              <span
                className={`text-sm ${item.checked ? 'line-through text-muted-foreground' : ''}`}
              >
                {item.text}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function TodoPage() {
  const [remote, setRemote] = useState<TodoGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<TodoFilter>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const navigate = useNavigate();

  // Subscribe to editor tabs so any buffer change (including direct checkbox
  // toggles via updateContent) triggers an immediate re-merge.
  const tabs = useEditorStore((s) => s.tabs);

  const fetchTodos = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getTodos(filter === 'open' ? { checked: false } : undefined);
      setRemote(res.data ?? []);
    } catch {
      setRemote([]);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchTodos();
  }, [fetchTodos]);

  const groups = useMemo(() => mergeWithDirtyTabs(remote, tabs, filter), [remote, tabs, filter]);

  // Auto-expand all groups on first load for discoverability.
  useEffect(() => {
    setExpanded((prev) => {
      const next = { ...prev };
      for (const g of groups) {
        if (next[g.note_id] === undefined) next[g.note_id] = true;
      }
      return next;
    });
  }, [groups]);

  const handleToggle = useCallback(
    async (noteId: string, item: TodoItem) => {
      // Check if the note is currently open in an editor tab.
      const openTab = useEditorStore.getState().tabs.find((t) => t.noteId === noteId);

      if (openTab) {
        // Route through the editor store so unsaved edits are preserved.
        const newContent = toggleTodoLine(openTab.content, item.line);
        useEditorStore.getState().updateContent(noteId, newContent);
        // No API call — user will Cmd+S in the editor to persist.
        return;
      }

      // Not open — safe to write directly via the daemon.
      try {
        await api.toggleTodo(noteId, item.line);
        await fetchTodos();
      } catch {
        // Silent failure; a future toast system will surface this.
      }
    },
    [fetchTodos],
  );

  const handleOpenNote = useCallback(
    (noteId: string) => {
      openNoteById(noteId);
      navigate('/');
    },
    [navigate],
  );

  const expandAll = useCallback(() => {
    setExpanded(Object.fromEntries(groups.map((g) => [g.note_id, true])));
  }, [groups]);

  const collapseAll = useCallback(() => {
    setExpanded(Object.fromEntries(groups.map((g) => [g.note_id, false])));
  }, [groups]);

  const totalItems = groups.reduce((sum, g) => sum + g.items.length, 0);

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 p-3 border-b border-border">
        <div className="flex items-center gap-3">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as TodoFilter)}>
            <TabsList>
              <TabsTrigger value="all">全部</TabsTrigger>
              <TabsTrigger value="open">未完成</TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="text-xs text-muted-foreground">
            {groups.length} 个笔记 / {totalItems} 项
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={expandAll}
              title="全部展开"
              disabled={groups.length === 0}
            >
              <ChevronsUpDown className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={collapseAll}
              title="全部折叠"
              disabled={groups.length === 0}
            >
              <ChevronsDownUp className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {loading && remote.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : groups.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {filter === 'open' ? '没有未完成的待办' : '没有待办项'}
          </div>
        ) : (
          groups.map((g) => (
            <TodoGroupRow
              key={g.note_id}
              group={g}
              filter={filter}
              expanded={expanded[g.note_id] ?? true}
              onToggleExpand={() =>
                setExpanded((prev) => ({ ...prev, [g.note_id]: !(prev[g.note_id] ?? true) }))
              }
              onToggle={(item) => handleToggle(g.note_id, item)}
              onOpen={() => handleOpenNote(g.note_id)}
            />
          ))
        )}
      </ScrollArea>
    </div>
  );
}
