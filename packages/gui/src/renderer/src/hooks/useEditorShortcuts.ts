import type { ShortcutsConfig } from '@/lib/api';
import { matchesShortcut } from '@/lib/shortcuts';
import { useConfigStore } from '@/stores/config-store';
import type { OpenNoteIntent, OpenOutcome } from '@/stores/note-nav-guard';
import { useNoteStore } from '@/stores/note-store';
import { useEffect } from 'react';
import { useEditorStore } from '../stores/editor-store';

interface ShortcutHandlers {
  requestCloseTab: (noteId: string) => void;
  /** Injected note opener (`useOpenNote`): desktop opens a tab + navigate('/'),
   *  mobile routes to the `/note/:id` detail. Cmd+N opens the fresh note. */
  openNote: (intent: OpenNoteIntent) => Promise<OpenOutcome>;
}

type ShortcutAction = (handlers: ShortcutHandlers) => void;

// Actions map onto ShortcutsConfig keys. Nav shortcuts are handled in App.tsx;
// here we only cover editor-context actions.
const ACTIONS: Partial<Record<keyof ShortcutsConfig, ShortcutAction>> = {
  save: () => {
    // Route through requestSaveOrConflict so AI-staged divergences can
    // raise a ConflictDialog before the PATCH fires. Direct callers
    // (e.g. UnsavedDialog's "save and close") still use saveNote for
    // the fast path where we've already committed to overwriting.
    const { activeTabId } = useEditorStore.getState();
    if (activeTabId) void useEditorStore.getState().requestSaveOrConflict(activeTabId);
  },
  close_tab: ({ requestCloseTab }) => {
    const { activeTabId } = useEditorStore.getState();
    if (activeTabId) requestCloseTab(activeTabId);
  },
  new_note: ({ openNote }) => {
    useNoteStore
      .getState()
      .createNote()
      .then((note) => {
        if (note) void openNote({ noteId: note.id });
      });
  },
  toggle_edit_mode: () => {
    useEditorStore.getState().cycleMode();
  },
  toggle_wrap: () => {
    useEditorStore.getState().toggleLineWrap();
  },
};

/**
 * `close_tab` (default `Mod-KeyW`) collides with macOS's Cmd+W = "Close
 * Window". The renderer's window-capture listener would otherwise eat
 * every Cmd+W and trap the user inside the app. Only intercept when
 * focus is inside the CodeMirror editor area AND there's an open tab to
 * close — otherwise return without preventDefault so the OS default
 * (close window) can take over.
 */
function shouldInterceptCloseTab(): boolean {
  const inEditor = document.activeElement?.closest('.cm-editor') != null;
  if (!inEditor) return false;
  return useEditorStore.getState().activeTabId != null;
}

/** Non-configurable `Mod+<key>` focus helpers (no modifiers beyond Mod): code → target selector. */
const FOCUS_HELPERS: Record<string, string> = {
  KeyL: '[data-tag-input]', // Mod+L → tag input
  KeyE: '.cm-content', // Mod+E → editor content
};

/** Dispatch the first matching configured editor shortcut; returns true when one fired (preventDefault done). */
function dispatchConfiguredAction(e: KeyboardEvent, handlers: ShortcutHandlers): boolean {
  const shortcuts = useConfigStore.getState().shortcuts;
  for (const action of Object.keys(ACTIONS) as (keyof ShortcutsConfig)[]) {
    const binding = shortcuts[action];
    if (!binding || !matchesShortcut(e, binding)) continue;
    if (action === 'close_tab' && !shouldInterceptCloseTab()) continue;
    e.preventDefault();
    ACTIONS[action]?.(handlers);
    return true;
  }
  return false;
}

/** Dispatch a non-configurable `Mod+<key>` focus helper; returns true when one fired. */
function dispatchFocusHelper(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  const selector = FOCUS_HELPERS[e.code];
  if (!selector) return false;
  const target = document.querySelector<HTMLElement>(selector);
  if (!target) return false;
  e.preventDefault();
  target.focus();
  return true;
}

export function useEditorShortcuts(handlers: ShortcutHandlers) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (dispatchConfiguredAction(e, handlers)) return;
      dispatchFocusHelper(e);
    };

    // Use capture phase to intercept before CodeMirror handles the event
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [handlers]);
}
