import { create } from 'zustand';
import { useEditorStore } from './editor-store';

/**
 * ③ addendum — guard a profile switch against unsaved tabs.
 *
 * A profile switch (`activateSession`) resets every store, silently dropping
 * dirty editor tabs (the old `location.reload()` did too — desktop has no
 * `beforeunload` guard). This gates the three desktop switch entry points
 * (login / logout / quick-switch) behind a batch prompt so unsaved work isn't
 * lost without a choice.
 *
 * `request()` is the seam callers await: it resolves `true` to proceed (no
 * dirty tabs, or the user chose 放弃 / 保存全部-succeeded) and `false` to abort.
 * The pending resolver lives at module scope so the dialog (mounted once in
 * MainApp, outside the caller's component) can settle it.
 */

let pendingResolve: ((proceed: boolean) => void) | null = null;

interface SwitchGuardState {
  /** True while the unsaved-tabs prompt is showing. */
  open: boolean;
  /** Unsaved tab count captured when the prompt opened (for the message). */
  unsavedCount: number;
  /** True while 保存全部 is running. */
  saving: boolean;
  /** True after a save-all attempt left tabs unsaved (offer 重试). */
  saveFailed: boolean;
  /**
   * Gate a switch on unsaved tabs. No dirty tabs → resolves `true` at once;
   * otherwise opens the prompt and resolves on the user's choice.
   */
  request: () => Promise<boolean>;
  /** 放弃并切换 — proceed, dropping unsaved edits. */
  discard: () => void;
  /** 保存全部并切换 — save every dirty tab to the current profile, then proceed. */
  saveAll: () => Promise<void>;
  /** 取消 — abort the switch, keep everything as-is. */
  cancel: () => void;
}

export const useSwitchGuard = create<SwitchGuardState>((set) => {
  const settle = (proceed: boolean): void => {
    const resolve = pendingResolve;
    pendingResolve = null;
    set({ open: false, saving: false, saveFailed: false, unsavedCount: 0 });
    resolve?.(proceed);
  };

  return {
    open: false,
    unsavedCount: 0,
    saving: false,
    saveFailed: false,

    request: () => {
      const unsaved = useEditorStore.getState().getUnsavedTabs();
      if (unsaved.length === 0) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        pendingResolve = resolve;
        set({ open: true, unsavedCount: unsaved.length, saving: false, saveFailed: false });
      });
    },

    discard: () => settle(true),
    cancel: () => settle(false),

    saveAll: async () => {
      set({ saving: true, saveFailed: false });
      const editor = useEditorStore.getState();
      // Re-read each attempt so a retry only re-saves what's still dirty.
      const unsaved = editor.getUnsavedTabs();
      const results = await Promise.all(unsaved.map((t) => editor.saveNote(t.noteId)));
      if (results.some((r) => !r.ok)) {
        // A save failed (daemon down, or a web 409 surfaced its own dialog).
        // Keep the prompt open so the user can retry or fall back to 放弃.
        set({ saving: false, saveFailed: true });
        return;
      }
      settle(true);
    },
  };
});
