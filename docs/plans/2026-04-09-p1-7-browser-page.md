# P1-7 Browser Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the browse page with search, tag filtering (Popover), sort, and Cmd+R reset.

**Architecture:** New `useBrowserStore` zustand store manages persistent filter state (query, activeTags, sortBy). BrowserPage renders a top action bar + reuses `NoteListItem`. Backend gets `sort_by` param support. Click navigates to editor page.

**Tech Stack:** React, zustand, shadcn/ui (Popover, Badge, Input, Button, ScrollArea, DropdownMenu), react-router-dom, existing API layer.

---

### Task 1: Add `sort_by` param to core `listNotes`

**Files:**
- Modify: `packages/core/src/notes/index.ts:39-46` (ListNotesOptions) and `:170-178` (orderBy)

**Step 1: Add `sortBy` to `ListNotesOptions`**

In `packages/core/src/notes/index.ts`, update the interface:

```typescript
export interface ListNotesOptions {
  q?: string;
  folderId?: string | null;
  trashLevel?: number;
  tagValues?: string[];
  page?: number;
  limit?: number;
  sortBy?: 'updated' | 'created';
}
```

**Step 2: Use `sortBy` in the query**

In the `listNotes` function, update the destructuring (line ~105) to include `sortBy = 'updated'`:

```typescript
const { q, folderId, trashLevel = 0, tagValues, page = 1, limit = 20, sortBy = 'updated' } = options;
```

Then replace the hardcoded orderBy (line ~175):

```typescript
const orderCol = sortBy === 'created' ? notes.createdAt : notes.updatedAt;

const rows = db
  .select()
  .from(notes)
  .where(where)
  .orderBy(sql`${orderCol} DESC`)
  .limit(limit)
  .offset(offset)
  .all();
```

**Step 3: Run typecheck**

Run: `pnpm --filter @owl/core exec tsc --noEmit`
Expected: PASS

---

### Task 2: Add `sort_by` param to daemon route and API client

**Files:**
- Modify: `packages/daemon/src/routes/notes.ts:19-39` (GET /notes handler)
- Modify: `packages/gui/src/renderer/src/lib/api.ts:106-123` (listNotes function)

**Step 1: Update daemon route**

In `packages/daemon/src/routes/notes.ts`, add `sort_by` to the query type and pass it through:

```typescript
const query = req.query as {
  q?: string;
  folder_id?: string;
  trash_level?: string;
  tags?: string;
  sort_by?: string;
  page?: string;
  limit?: string;
};

const result = listNotes(ctx.db, ctx.sqlite, {
  q: query.q,
  folderId: query.folder_id === 'null' ? null : query.folder_id,
  trashLevel: query.trash_level ? Number(query.trash_level) : 0,
  tagValues: query.tags ? query.tags.split(',') : undefined,
  sortBy: query.sort_by === 'created' ? 'created' : 'updated',
  page: query.page ? Number(query.page) : 1,
  limit: query.limit ? Number(query.limit) : 20,
});
```

**Step 2: Update API client**

In `packages/gui/src/renderer/src/lib/api.ts`, add `sort_by` to `listNotes`:

```typescript
export function listNotes(params?: {
  q?: string;
  folder_id?: string;
  trash_level?: number;
  tags?: string;
  sort_by?: 'updated' | 'created';
  page?: number;
  limit?: number;
}) {
  const qs = new URLSearchParams();
  if (params?.q) qs.set('q', params.q);
  if (params?.folder_id) qs.set('folder_id', params.folder_id);
  if (params?.trash_level !== undefined) qs.set('trash_level', String(params.trash_level));
  if (params?.tags) qs.set('tags', params.tags);
  if (params?.sort_by) qs.set('sort_by', params.sort_by);
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return request<Note[]>('GET', `/notes${query ? `?${query}` : ''}`);
}
```

**Step 3: Run typecheck**

Run: `just check`
Expected: PASS

---

### Task 3: Create `useBrowserStore`

**Files:**
- Create: `packages/gui/src/renderer/src/stores/browser-store.ts`

**Step 1: Write the store**

```typescript
import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import { create } from 'zustand';

interface BrowserState {
  query: string;
  activeTags: string[];
  sortBy: 'updated' | 'created';
  notes: Note[];
  total: number;
  loading: boolean;

  setQuery: (q: string) => void;
  addTag: (tag: string) => void;
  removeTag: (tag: string) => void;
  setSortBy: (sort: 'updated' | 'created') => void;
  fetchNotes: () => Promise<void>;
  resetFilters: () => void;
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  query: '',
  activeTags: [],
  sortBy: 'updated',
  notes: [],
  total: 0,
  loading: false,

  setQuery: (q: string) => {
    set({ query: q });
    get().fetchNotes();
  },

  addTag: (tag: string) => {
    const { activeTags } = get();
    if (!activeTags.includes(tag)) {
      set({ activeTags: [...activeTags, tag] });
      get().fetchNotes();
    }
  },

  removeTag: (tag: string) => {
    set({ activeTags: get().activeTags.filter((t) => t !== tag) });
    get().fetchNotes();
  },

  setSortBy: (sort: 'updated' | 'created') => {
    set({ sortBy: sort });
    get().fetchNotes();
  },

  fetchNotes: async () => {
    const { query, activeTags, sortBy } = get();
    set({ loading: true });
    try {
      const res = await api.listNotes({
        q: query || undefined,
        tags: activeTags.length > 0 ? activeTags.join(',') : undefined,
        sort_by: sortBy,
        limit: 100,
      });
      set({ notes: res.data ?? [], total: res.total ?? 0 });
    } finally {
      set({ loading: false });
    }
  },

  resetFilters: () => {
    set({ query: '', activeTags: [], sortBy: 'updated' });
    get().fetchNotes();
  },
}));
```

**Step 2: Run typecheck**

Run: `pnpm --filter @owl/gui exec tsc --noEmit`
Expected: PASS

---

### Task 4: Create `TagFilterPopover` component

**Files:**
- Create: `packages/gui/src/renderer/src/components/TagFilterPopover.tsx`

**Step 1: Write the component**

```typescript
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTagStore } from '@/stores/tag-store';
import { Check, Filter } from 'lucide-react';
import { useEffect, useState } from 'react';

interface TagFilterPopoverProps {
  activeTags: string[];
  onToggleTag: (tag: string) => void;
}

export function TagFilterPopover({ activeTags, onToggleTag }: TagFilterPopoverProps) {
  const { tags, fetchTags } = useTagStore();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) fetchTags();
  }, [open, fetchTags]);

  const filtered = search
    ? tags.filter((t) => t.tagValue.toLowerCase().includes(search.toLowerCase()))
    : tags;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5">
          <Filter className="size-3.5" />
          标签筛选
          {activeTags.length > 0 && (
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
              {activeTags.length}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <div className="p-2 border-b border-border">
          <Input
            placeholder="搜索标签..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 text-xs"
          />
        </div>
        <ScrollArea className="max-h-60">
          {filtered.length === 0 ? (
            <div className="p-3 text-center text-xs text-muted-foreground">无匹配标签</div>
          ) : (
            filtered.map((tag) => {
              const isActive = activeTags.includes(tag.tagValue);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => onToggleTag(tag.tagValue)}
                  className="flex items-center w-full px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors"
                >
                  <span className="flex-1 text-left">#{tag.tagValue}</span>
                  {isActive && <Check className="size-3.5 text-primary" />}
                </button>
              );
            })
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
```

**Step 2: Run typecheck**

Run: `pnpm --filter @owl/gui exec tsc --noEmit`
Expected: PASS

---

### Task 5: Implement `BrowserPage`

**Files:**
- Modify: `packages/gui/src/renderer/src/pages/BrowserPage.tsx`

**Step 1: Replace placeholder with full implementation**

```typescript
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
import { useBrowserStore } from '@/stores/browser-store';
import { openNoteById } from '@/stores/editor-store';
import { ArrowDownAZ, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

export function BrowserPage() {
  const {
    query,
    activeTags,
    sortBy,
    notes,
    total,
    loading,
    setQuery,
    addTag,
    removeTag,
    setSortBy,
    fetchNotes,
    resetFilters,
  } = useBrowserStore();

  const navigate = useNavigate();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  // Cmd+R to reset filters
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'r') {
        e.preventDefault();
        if (inputRef.current) inputRef.current.value = '';
        resetFilters();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [resetFilters]);

  const handleSearch = useCallback(
    (value: string) => {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setQuery(value), 300);
    },
    [setQuery],
  );

  const handleToggleTag = useCallback(
    (tag: string) => {
      if (activeTags.includes(tag)) {
        removeTag(tag);
      } else {
        addTag(tag);
      }
    },
    [activeTags, addTag, removeTag],
  );

  const handleSelectNote = useCallback(
    (noteId: string) => {
      openNoteById(noteId);
      navigate('/');
    },
    [navigate],
  );

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
              defaultValue={query}
              onChange={(e) => handleSearch(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>

          {/* Tag filter */}
          <TagFilterPopover activeTags={activeTags} onToggleTag={handleToggleTag} />

          {/* Sort */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 gap-1.5">
                <ArrowDownAZ className="size-3.5" />
                {sortBy === 'updated' ? '更新时间' : '创建时间'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setSortBy('updated')}>更新时间</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSortBy('created')}>创建时间</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Active tags */}
        {activeTags.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground">已筛选:</span>
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
            {query || activeTags.length > 0 ? '无匹配结果' : '暂无笔记'}
          </div>
        ) : (
          <>
            <div className="px-3 py-1.5 text-xs text-muted-foreground">
              共 {total} 条笔记
            </div>
            {notes.map((note) => (
              <NoteListItem
                key={note.id}
                note={note}
                isActive={false}
                onClick={() => handleSelectNote(note.id)}
              />
            ))}
          </>
        )}
      </ScrollArea>
    </div>
  );
}
```

**Step 2: Run typecheck**

Run: `just check`
Expected: PASS

---

### Task 6: Verify and commit

**Step 1: Run full check**

Run: `just check`
Expected: PASS with zero errors

**Step 2: Start daemon for manual testing**

Run: `just dev-daemon`

**Step 3: Output manual test checklist**

Provide manual test steps for user to verify with `just dev`.

**Step 4: Commit after user approval**

```
feat(browser): add browse page with search, tag filter, and sort

Closes P1-7: browse page with Popover tag filtering, FTS search,
sort by updated/created time, and Cmd+R filter reset.
```
