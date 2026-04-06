import { useNoteStore } from '@/stores/note-store';
import { useEffect } from 'react';
import { openNoteById, useEditorStore } from '../stores/editor-store';

interface ShortcutHandlers {
  requestCloseTab: (noteId: string) => void;
}

type ShortcutAction = (handlers: ShortcutHandlers) => void;

// key format: "meta+KeyX" or "meta+alt+KeyX" (using e.code for Alt-key safety)
const SHORTCUTS: Record<string, ShortcutAction> = {
  'meta+KeyS': () => {
    useEditorStore.getState().saveActiveNote();
  },
  'meta+KeyW': ({ requestCloseTab }) => {
    const { activeTabId } = useEditorStore.getState();
    if (activeTabId) requestCloseTab(activeTabId);
  },
  'meta+KeyN': () => {
    useNoteStore
      .getState()
      .createNote()
      .then((note) => {
        if (note) openNoteById(note.id);
      });
  },
  'meta+alt+KeyV': () => {
    useEditorStore.getState().cycleMode();
  },
};

function getShortcutKey(e: KeyboardEvent): string | null {
  if (!e.metaKey && !e.ctrlKey) return null;
  const parts = ['meta'];
  if (e.altKey) parts.push('alt');
  parts.push(e.code);
  return parts.join('+');
}

export function useEditorShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const key = getShortcutKey(e);
      if (!key) return;
      const action = SHORTCUTS[key];
      if (action) {
        e.preventDefault();
        action(handlers);
      }
    };

    // Use capture phase to intercept before CodeMirror handles the event
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [handlers]);
}
