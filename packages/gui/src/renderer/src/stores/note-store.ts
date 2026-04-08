import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import { create } from 'zustand';

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
      // If query starts with #, strip it and search via tags param
      // (daemon filters by tag value from note_tags table)
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
      if (note) {
        // Refresh list so the new note appears
        await get().fetchNotes();
      }
      return note;
    } catch {
      return null;
    }
  },
}));
