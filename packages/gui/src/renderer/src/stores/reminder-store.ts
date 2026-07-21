import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import type { TimeRange } from '@/lib/reminder-utils';
import { create } from 'zustand';
import { currentGen, isStale } from './session-epoch';

interface ReminderState {
  timeRange: TimeRange;
  notes: Note[];
  loading: boolean;

  setTimeRange: (range: TimeRange) => void;
  fetchReminders: () => Promise<void>;
  /** ③: back to the initial per-session shape. */
  reset: () => void;
}

export const useReminderStore = create<ReminderState>((set) => ({
  timeRange: 'all',
  notes: [],
  loading: false,

  setTimeRange: (range: TimeRange) => {
    set({ timeRange: range });
  },

  fetchReminders: async () => {
    const gen = currentGen();
    set({ loading: true });
    try {
      const res = await api.listAlarmNotes();
      if (isStale(gen)) return;
      set({ notes: res.data ?? [] });
    } finally {
      if (!isStale(gen)) set({ loading: false });
    }
  },

  reset: () => set({ timeRange: 'all', notes: [], loading: false }),
}));
