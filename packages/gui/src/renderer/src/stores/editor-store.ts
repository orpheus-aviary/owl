import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import { create } from 'zustand';

export type EditorMode = 'edit' | 'split' | 'preview';

export interface TabState {
  noteId: string;
  title: string;
  content: string;
  originalContent: string;
  dirty: boolean;
}

interface EditorState {
  tabs: TabState[];
  activeTabId: string | null;
  mode: EditorMode;

  openNote: (note: Note) => void;
  closeTab: (noteId: string) => void;
  setActiveTab: (noteId: string) => void;
  updateContent: (noteId: string, content: string) => void;
  markSaved: (noteId: string, content: string) => void;
  cycleMode: () => void;
  setMode: (mode: EditorMode) => void;
}

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  if (match) return match[1].trim();
  const firstLine = content.split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 30) || '无标题';
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  mode: 'edit',

  openNote: (note: Note) => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.noteId === note.id);
    if (existing) {
      set({ activeTabId: note.id });
      return;
    }
    const newTab: TabState = {
      noteId: note.id,
      title: extractTitle(note.content),
      content: note.content,
      originalContent: note.content,
      dirty: false,
    };
    set({ tabs: [...tabs, newTab], activeTabId: note.id });
  },

  closeTab: (noteId: string) => {
    const { tabs, activeTabId } = get();
    const idx = tabs.findIndex((t) => t.noteId === noteId);
    if (idx === -1) return;
    const newTabs = tabs.filter((t) => t.noteId !== noteId);
    let newActiveId = activeTabId;
    if (activeTabId === noteId) {
      if (newTabs.length === 0) {
        newActiveId = null;
      } else if (idx >= newTabs.length) {
        newActiveId = newTabs[newTabs.length - 1].noteId;
      } else {
        newActiveId = newTabs[idx].noteId;
      }
    }
    set({ tabs: newTabs, activeTabId: newActiveId });
  },

  setActiveTab: (noteId: string) => {
    set({ activeTabId: noteId });
  },

  updateContent: (noteId: string, content: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.noteId === noteId
          ? {
              ...t,
              content,
              title: extractTitle(content),
              dirty: content !== t.originalContent,
            }
          : t,
      ),
    }));
  },

  markSaved: (noteId: string, content: string) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.noteId === noteId ? { ...t, originalContent: content, dirty: false } : t,
      ),
    }));
  },

  cycleMode: () => {
    const order: EditorMode[] = ['edit', 'split', 'preview'];
    const { mode } = get();
    const next = order[(order.indexOf(mode) + 1) % order.length];
    set({ mode: next });
  },

  setMode: (mode: EditorMode) => {
    set({ mode });
  },
}));

// Selector for active tab
export function useActiveTab(): TabState | null {
  return useEditorStore((s) => s.tabs.find((t) => t.noteId === s.activeTabId) ?? null);
}

// Open note by ID (fetches from API then opens)
export async function openNoteById(noteId: string): Promise<void> {
  const res = await api.getNote(noteId);
  if (res.data) {
    useEditorStore.getState().openNote(res.data);
  }
}
