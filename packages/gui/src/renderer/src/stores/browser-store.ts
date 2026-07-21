import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import { create } from 'zustand';
import { useDataBus } from './data-bus';
import { currentGen, isStale } from './session-epoch';

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
  /** ③: back to the initial per-session shape (distinct from `resetFilters`,
   *  which keeps the store alive and refetches). */
  reset: () => void;
}

const initialState = (): Pick<
  BrowserState,
  'query' | 'activeTags' | 'sortKey' | 'folderId' | 'notes' | 'total' | 'loading'
> => ({
  query: '',
  activeTags: [],
  sortKey: 'updated_desc',
  folderId: undefined,
  notes: [],
  total: 0,
  loading: false,
});

function parseSortKey(key: SortKey): {
  sort_by: 'updated' | 'created';
  sort_order: 'asc' | 'desc';
} {
  const [field, order] = key.split('_') as ['updated' | 'created', 'asc' | 'desc'];
  return { sort_by: field, sort_order: order };
}

export const useBrowserStore = create<BrowserState>((set, get) => ({
  ...initialState(),

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
    const gen = currentGen();
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
        // P3.4-a: pin group at top; each group applies user-chosen sort.
        pinned_first: true,
        limit: 100,
      });
      if (isStale(gen)) return;
      set({ notes: res.data ?? [], total: res.total ?? 0 });
    } finally {
      if (!isStale(gen)) set({ loading: false });
    }
  },

  resetFilters: () => {
    set({ query: '', activeTags: [], sortKey: 'updated_desc', folderId: undefined });
    get().fetchNotes();
  },

  reset: () => set(initialState()),
}));

// Refetch when notes change anywhere in the app — keeps the browse page
// list consistent with mutations from EditorPage / FolderPanel / Trash etc.
useDataBus.subscribe((state, prev) => {
  if (state.noteVersion !== prev.noteVersion) {
    void useBrowserStore.getState().fetchNotes();
  }
});
