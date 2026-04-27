import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import { create } from 'zustand';
import { useDataBus } from './data-bus';

interface NoteState {
  notes: Note[];
  total: number;
  query: string;
  page: number;
  loading: boolean;

  fetchNotes: () => Promise<void>;
  setQuery: (q: string) => void;
  createNote: () => Promise<Note | null>;
}

export const useNoteStore = create<NoteState>((set, get) => ({
  notes: [],
  total: 0,
  query: '',
  page: 1,
  loading: false,

  fetchNotes: async () => {
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
      });
      set({ notes: res.data ?? [], total: res.total ?? 0 });
    } finally {
      set({ loading: false });
    }
  },

  setQuery: (q: string) => {
    set({ query: q, page: 1 });
    get().fetchNotes();
  },

  createNote: async () => {
    try {
      const res = await api.createNote({ content: '# \n\n' });
      const note = res.data ?? null;
      if (note) useDataBus.getState().bumpNotes();
      return note;
    } catch {
      return null;
    }
  },
}));

// Refetch on any external note mutation. data-bus is the single notify
// channel; we listen here so every consumer of useNoteStore stays current
// without each page wiring its own refresh logic.
useDataBus.subscribe((state, prev) => {
  if (state.noteVersion !== prev.noteVersion) {
    void useNoteStore.getState().fetchNotes();
  }
});
