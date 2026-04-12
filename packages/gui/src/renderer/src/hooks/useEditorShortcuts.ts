import type { ShortcutsConfig } from '@/lib/api';
import { matchesShortcut } from '@/lib/shortcuts';
import { useConfigStore } from '@/stores/config-store';
import { useNoteStore } from '@/stores/note-store';
import { useEffect } from 'react';
import { openNoteById, useEditorStore } from '../stores/editor-store';

interface ShortcutHandlers {
  requestCloseTab: (noteId: string) => void;
}

type ShortcutAction = (handlers: ShortcutHandlers) => void;

// Actions map onto ShortcutsConfig keys. Nav shortcuts are handled in App.tsx;
// here we only cover editor-context actions.
const ACTIONS: Partial<Record<keyof ShortcutsConfig, ShortcutAction>> = {
  save: () => {
    useEditorStore.getState().saveActiveNote();
  },
  close_tab: ({ requestCloseTab }) => {
    const { activeTabId } = useEditorStore.getState();
    if (activeTabId) requestCloseTab(activeTabId);
  },
  new_note: () => {
    useNoteStore
      .getState()
      .createNote()
      .then((note) => {
        if (note) openNoteById(note.id);
      });
  },
  toggle_edit_mode: () => {
    useEditorStore.getState().cycleMode();
  },
  toggle_wrap: () => {
    useEditorStore.getState().toggleLineWrap();
  },
};

export function useEditorShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const shortcuts = useConfigStore.getState().shortcuts;
      for (const action of Object.keys(ACTIONS) as (keyof ShortcutsConfig)[]) {
        const binding = shortcuts[action];
        if (binding && matchesShortcut(e, binding)) {
          e.preventDefault();
          ACTIONS[action]?.(handlers);
          return;
        }
      }
      // Non-configurable focus helpers.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        if (e.code === 'KeyL') {
          const tagInput = document.querySelector<HTMLInputElement>('[data-tag-input]');
          if (tagInput) {
            e.preventDefault();
            tagInput.focus();
          }
        } else if (e.code === 'KeyE') {
          const cmEditor = document.querySelector<HTMLElement>('.cm-content');
          if (cmEditor) {
            e.preventDefault();
            cmEditor.focus();
          }
        }
      }
    };

    // Use capture phase to intercept before CodeMirror handles the event
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [handlers]);
}
