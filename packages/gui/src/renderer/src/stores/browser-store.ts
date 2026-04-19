import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import { create } from 'zustand';

export type SortKey = 'updated_desc' | 'updated_asc' | 'created_desc' | 'created_asc';

interface BrowserState {
  query: string;
  activeTags: string[];
  sortKey: SortKey;
  folderId: string | undefined;
  notes: Note[];
  total: number;
  loading: boolean;

  setQuery: (q: string) => void;
  addTag: (tag: string) => void;
  removeTag: (tag: string) => void;
  setSortKey: (key: SortKey) => void;
  setFolderId: (id: string | undefined) => void;
  fetchNotes: () => Promise<void>;
  resetFilters: () => void;
}

function parseSortKey(key: SortKey): {
  sort_by: 'updated' | 'created';
  sort_order: 'asc' | 'desc';
} {
  const [field, order] = key.split('_') as ['updated' | 'created', 'asc' | 'desc'];
  return { sort_by: field, sort_order: order };
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  query: '',
  activeTags: [],
  sortKey: 'updated_desc',
  folderId: undefined,
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

  setSortKey: (key: SortKey) => {
    set({ sortKey: key });
    get().fetchNotes();
  },

  setFolderId: (id: string | undefined) => {
    if (get().folderId === id) return;
    set({ folderId: id });
    get().fetchNotes();
  },

  fetchNotes: async () => {
    const { query, activeTags, sortKey, folderId } = get();
    set({ loading: true });
    try {
      const res = await api.listNotes({
        q: query || undefined,
        folder_id: folderId,
        // Browse-page filter is subtree-scoped: selecting a folder should
        // match notes in that folder AND every descendant. Explicit so we
        // don't inherit behavior from the daemon default silently.
        include_descendants: folderId ? true : undefined,
        tags: activeTags.length > 0 ? activeTags.join(',') : undefined,
        ...parseSortKey(sortKey),
        limit: 100,
      });
      set({ notes: res.data ?? [], total: res.total ?? 0 });
    } finally {
      set({ loading: false });
    }
  },

  resetFilters: () => {
    set({ query: '', activeTags: [], sortKey: 'updated_desc', folderId: undefined });
    get().fetchNotes();
  },
}));
