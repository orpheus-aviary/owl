import type { FrequentTag, Tag } from '@/lib/api';
import * as api from '@/lib/api';
import { create } from 'zustand';
import { currentGen, isStale } from './session-epoch';

interface TagState {
  tags: Tag[];
  frequentTags: FrequentTag[];

  fetchTags: () => Promise<void>;
  fetchFrequentTags: () => Promise<void>;
  /** ③: back to the initial per-session shape. */
  reset: () => void;
}

export const useTagStore = create<TagState>((set) => ({
  tags: [],
  frequentTags: [],

  fetchTags: async () => {
    const gen = currentGen();
    try {
      const res = await api.listTags();
      if (isStale(gen)) return;
      set({ tags: res.data ?? [] });
    } catch {
      // silent — daemon may not be ready
    }
  },

  fetchFrequentTags: async () => {
    const gen = currentGen();
    try {
      const res = await api.listFrequentTags(20);
      if (isStale(gen)) return;
      set({ frequentTags: res.data ?? [] });
    } catch {
      // silent
    }
  },

  reset: () => set({ tags: [], frequentTags: [] }),
}));
