import type { FrequentTag, Tag } from '@/lib/api';
import * as api from '@/lib/api';
import { create } from 'zustand';

interface TagState {
  tags: Tag[];
  frequentTags: FrequentTag[];

  fetchTags: () => Promise<void>;
  fetchFrequentTags: () => Promise<void>;
}

export const useTagStore = create<TagState>((set) => ({
  tags: [],
  frequentTags: [],

  fetchTags: async () => {
    try {
      const res = await api.listTags();
      set({ tags: res.data ?? [] });
    } catch {
      // silent — daemon may not be ready
    }
  },

  fetchFrequentTags: async () => {
    try {
      const res = await api.listFrequentTags(20);
      set({ frequentTags: res.data ?? [] });
    } catch {
      // silent
    }
  },
}));
