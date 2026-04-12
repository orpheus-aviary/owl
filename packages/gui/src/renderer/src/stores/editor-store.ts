import type { Note, NoteTag } from '@/lib/api';
import * as api from '@/lib/api';
import { create } from 'zustand';
import { useNoteStore } from './note-store';

export type EditorMode = 'edit' | 'split' | 'preview';

export interface TabState {
  noteId: string;
  title: string;
  content: string;
  originalContent: string;
  tags: NoteTag[];
  originalTags: NoteTag[];
  dirty: boolean;
}

/** Compare two NoteTag arrays by tagType:tagValue pairs (order-insensitive). */
function tagsEqual(a: NoteTag[], b: NoteTag[]): boolean {
  if (a.length !== b.length) return false;
  const key = (t: NoteTag) => `${t.tagType}:${t.tagValue ?? ''}`;
  const setA = new Set(a.map(key));
  return b.every((t) => setA.has(key(t)));
}

/** Serialize NoteTag[] to raw tag strings for the daemon API. */
function serializeTags(tags: NoteTag[]): string[] {
  return tags.map((t) => {
    if (t.tagType === '#') return `#${t.tagValue}`;
    if (['/daily', '/weekly', '/monthly', '/yearly'].includes(t.tagType)) return t.tagType;
    // /time, /alarm — tagType + space + tagValue (ISO datetime)
    return `${t.tagType} ${t.tagValue}`;
  });
}

interface EditorState {
  tabs: TabState[];
  activeTabId: string | null;
  mode: EditorMode;
  lineWrap: boolean;

  openNote: (note: Note) => void;
  closeTab: (noteId: string) => void;
  setActiveTab: (noteId: string) => void;
  updateContent: (noteId: string, content: string) => void;
  updateTags: (noteId: string, tags: NoteTag[]) => void;
  markSaved: (noteId: string, content: string, tags: NoteTag[]) => void;
  saveNote: (noteId: string) => Promise<boolean>;
  saveActiveNote: () => Promise<boolean>;
  cycleMode: () => void;
  setMode: (mode: EditorMode) => void;
  toggleLineWrap: () => void;
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
  lineWrap: true,

  openNote: (note: Note) => {
    const { tabs } = get();
    const existing = tabs.find((t) => t.noteId === note.id);
    if (existing) {
      set({ activeTabId: note.id });
      return;
    }
    const tags = note.tags ?? [];
    const newTab: TabState = {
      noteId: note.id,
      title: extractTitle(note.content),
      content: note.content,
      originalContent: note.content,
      tags,
      originalTags: tags,
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
              dirty: content !== t.originalContent || !tagsEqual(t.tags, t.originalTags),
            }
          : t,
      ),
    }));
  },

  updateTags: (noteId: string, tags: NoteTag[]) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.noteId === noteId
          ? {
              ...t,
              tags,
              dirty: t.content !== t.originalContent || !tagsEqual(tags, t.originalTags),
            }
          : t,
      ),
    }));
  },

  markSaved: (noteId: string, content: string, tags: NoteTag[]) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.noteId === noteId
          ? { ...t, originalContent: content, originalTags: tags, dirty: false }
          : t,
      ),
    }));
  },

  saveNote: async (noteId: string) => {
    const tab = get().tabs.find((t) => t.noteId === noteId);
    if (!tab || !tab.dirty) return true;
    try {
      const rawTags = serializeTags(tab.tags);
      const res = await api.updateNote(tab.noteId, { content: tab.content, tags: rawTags });
      const savedTags = res.data?.tags ?? tab.tags;
      get().markSaved(tab.noteId, tab.content, savedTags);
      // Refresh note list so left sidebar shows updated tags
      useNoteStore.getState().fetchNotes();
      return true;
    } catch {
      return false;
    }
  },

  saveActiveNote: async () => {
    const { activeTabId } = get();
    if (!activeTabId) return true;
    return get().saveNote(activeTabId);
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

  toggleLineWrap: () => {
    set((state) => ({ lineWrap: !state.lineWrap }));
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
