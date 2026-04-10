import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import type { TimeRange } from '@/lib/reminder-utils';
import { create } from 'zustand';

interface ReminderState {
  timeRange: TimeRange;
  notes: Note[];
  loading: boolean;

  setTimeRange: (range: TimeRange) => void;
  fetchReminders: () => Promise<void>;
}

export const useReminderStore = create<ReminderState>((set, get) => ({
  timeRange: 'all',
  notes: [],
  loading: false,

  setTimeRange: (range: TimeRange) => {
    set({ timeRange: range });
  },

  fetchReminders: async () => {
    set({ loading: true });
    try {
      const res = await api.listAlarmNotes();
      set({ notes: res.data ?? [] });
    } finally {
      set({ loading: false });
    }
  },
}));
