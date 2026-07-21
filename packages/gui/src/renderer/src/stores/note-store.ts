import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import { create } from 'zustand';
import { useDataBus } from './data-bus';
import { currentGen, isStale } from './session-epoch';

interface NoteState {
  notes: Note[];
  total: number;
  query: string;
  page: number;
  loading: boolean;

  fetchNotes: () => Promise<void>;
  setQuery: (q: string) => void;
  createNote: () => Promise<Note | null>;
  /** ③: back to the initial per-session shape. */
  reset: () => void;
}

const initialState = (): Pick<NoteState, 'notes' | 'total' | 'query' | 'page' | 'loading'> => ({
  notes: [],
  total: 0,
  query: '',
  page: 1,
  loading: false,
});

export const useNoteStore = create<NoteState>((set, get) => ({
  ...initialState(),

  fetchNotes: async () => {
    const gen = currentGen();
    const { query, page } = get();
    set({ loading: true });
    try {
      let q: string | undefined;
      let tags: string | undefined;
      if (query.startsWith('#') && query.length > 1) {
        tags = query.slice(1);
      } else {
        q = query || undefined;
      }
      const res = await api.listNotes({
        q,
        tags,
        page,
        limit: 50,
        // P3.4-a: pin group at top; each group sorts by updated_at DESC (daemon default).
        pinned_first: true,
      });
      if (isStale(gen)) return; // session switched mid-fetch → don't cross accounts
      set({ notes: res.data ?? [], total: res.total ?? 0 });
    } finally {
      if (!isStale(gen)) set({ loading: false });
    }
  },

  setQuery: (q: string) => {
    set({ query: q, page: 1 });
    get().fetchNotes();
  },

  createNote: async () => {
    const gen = currentGen();
    try {
      const res = await api.createNote({ content: '# \n\n' });
      if (isStale(gen)) return null;
      const note = res.data ?? null;
      if (note) useDataBus.getState().bumpNotes();
      return note;
    } catch {
      return null;
    }
  },

  reset: () => set(initialState()),
}));

// Refetch on any external note mutation. data-bus is the single notify
// channel; we listen here so every consumer of useNoteStore stays current
// without each page wiring its own refresh logic.
useDataBus.subscribe((state, prev) => {
  if (state.noteVersion !== prev.noteVersion) {
    void useNoteStore.getState().fetchNotes();
  }
});
