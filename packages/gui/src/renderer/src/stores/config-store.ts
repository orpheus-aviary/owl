import * as api from '@/lib/api';
import type { OwlConfig, ShortcutsConfig } from '@/lib/api';
import { getPlatform } from '@/platform';
import { create } from 'zustand';
import { currentGen, isStale } from './session-epoch';

// Fallback defaults — mirror @owl/core DEFAULT_CONFIG so that pre-fetch UI
// (shortcut matching, font styling) has sensible values before the first
// daemon response lands.
const DEFAULT_SHORTCUTS: ShortcutsConfig = {
  save: 'Mod-KeyS',
  close_tab: 'Mod-KeyW',
  toggle_wrap: 'Alt-KeyZ',
  toggle_edit_mode: 'Mod-Alt-KeyV',
  new_note: 'Mod-KeyN',
  nav_editor: 'Mod-Digit1',
  nav_browser: 'Mod-Digit2',
  nav_trash: 'Mod-Digit3',
  nav_reminders: 'Mod-Digit4',
  nav_todo: 'Mod-Digit5',
  nav_ai: 'Mod-Digit6',
  nav_settings: 'Mod-Digit7',
  toggle_folder_panel: 'Mod-KeyB',
  global_invoke: 'Mod-Alt-KeyO',
};

/**
 * Push the global invoke binding to the main process. Fire-and-forget:
 * main logs its own failures, the user notices a non-firing shortcut and
 * picks a different key.
 */
async function syncGlobalShortcutWithMain(canonical: string): Promise<void> {
  // Electron-only capability — absent in the web host and in renderer-only
  // test environments where no platform is injected.
  const shortcut = getPlatform().shortcut;
  if (!shortcut?.setGlobal) return;
  try {
    await shortcut.setGlobal(canonical);
  } catch {
    // Swallow IPC errors — main is best-effort, no UI surface here.
  }
}

const DEFAULT_FONT: OwlConfig['font'] = {
  global_offset: 0,
  editor_font_size: 14,
  editor_line_height: 1.6,
};

const DEFAULT_WINDOW: OwlConfig['window'] = { width: 1000, height: 700 };

const DEFAULT_LLM: OwlConfig['llm'] = {
  url: '',
  model: '',
  api_key: '',
  api_format: 'openai',
  thinking_round_trip: true,
};

const DEFAULT_TRASH: OwlConfig['trash'] = { auto_delete_days: 30 };

const DEFAULT_EDITOR: OwlConfig['editor'] = { default_mode: 'edit' };

const DEFAULT_BROWSER: OwlConfig['browser'] = {
  default_sort_field: 'updated',
  default_sort_direction: 'desc',
};

const DEFAULT_AI: OwlConfig['ai'] = {
  context_rounds: 3,
  max_recent_notes: 5,
  max_context_chars: 30000,
};

const DEFAULT_LOG: OwlConfig['log'] = {
  max_size_mb: 10,
  max_backups: 5,
  max_age_days: 30,
  level: 'info',
};

/** Base html font size (px) before `global_offset` is applied. */
const BASE_FONT_SIZE = 16;

/** Apply a font config to the root `<html>` element via CSS variables. */
function applyFontToRoot(font: OwlConfig['font']): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.fontSize = `${BASE_FONT_SIZE + font.global_offset}px`;
  root.style.setProperty('--owl-editor-font-size', `${font.editor_font_size}px`);
  root.style.setProperty('--owl-editor-line-height', String(font.editor_line_height));
}

interface ConfigState {
  config: OwlConfig | null;
  shortcuts: ShortcutsConfig;
  font: OwlConfig['font'];
  window: OwlConfig['window'];
  llm: OwlConfig['llm'];
  trash: OwlConfig['trash'];
  editor: OwlConfig['editor'];
  browser: OwlConfig['browser'];
  ai: OwlConfig['ai'];
  log: OwlConfig['log'];
  loading: boolean;
  error: string | null;

  fetch: () => Promise<void>;
  patchShortcuts: (delta: Partial<ShortcutsConfig>) => Promise<boolean>;
  resetShortcuts: () => Promise<boolean>;
  patchFont: (delta: Partial<OwlConfig['font']>) => Promise<boolean>;
  patchWindow: (delta: Partial<OwlConfig['window']>) => Promise<boolean>;
  patchLlm: (delta: Partial<OwlConfig['llm']>) => Promise<boolean>;
  patchTrash: (delta: Partial<OwlConfig['trash']>) => Promise<boolean>;
  patchEditor: (delta: Partial<OwlConfig['editor']>) => Promise<boolean>;
  patchBrowser: (delta: Partial<OwlConfig['browser']>) => Promise<boolean>;
  patchAi: (delta: Partial<OwlConfig['ai']>) => Promise<boolean>;
  patchLog: (delta: Partial<OwlConfig['log']>) => Promise<boolean>;
  /** ③: back to fallback defaults (bootstrap re-fetches the new session's config). */
  reset: () => void;
}

function applyConfig(set: (update: Partial<ConfigState>) => void, config: OwlConfig): void {
  applyFontToRoot(config.font);
  set({
    config,
    shortcuts: config.shortcuts,
    font: config.font,
    window: config.window,
    llm: config.llm,
    trash: config.trash,
    editor: config.editor,
    browser: config.browser,
    ai: config.ai,
    log: config.log,
  });
}

/**
 * ③ generation-guarded PATCH /config for the sections with no extra
 * side-effect (everything but shortcuts, which also pushes the global hotkey
 * to main). Captures the session gen up front and drops the applyConfig
 * write-back if the session switched mid-request.
 */
async function runSimplePatch(
  set: (update: Partial<ConfigState>) => void,
  build: () => Promise<{ data?: OwlConfig }>,
): Promise<boolean> {
  const gen = currentGen();
  try {
    const res = await build();
    if (isStale(gen)) return false;
    if (res.data) {
      applyConfig(set, res.data);
      return true;
    }
    return false;
  } catch (err) {
    if (isStale(gen)) return false;
    set({ error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  shortcuts: DEFAULT_SHORTCUTS,
  font: DEFAULT_FONT,
  window: DEFAULT_WINDOW,
  llm: DEFAULT_LLM,
  trash: DEFAULT_TRASH,
  editor: DEFAULT_EDITOR,
  browser: DEFAULT_BROWSER,
  ai: DEFAULT_AI,
  log: DEFAULT_LOG,
  loading: false,
  error: null,

  fetch: async () => {
    const gen = currentGen();
    set({ loading: true, error: null });
    try {
      const res = await api.getConfig();
      if (isStale(gen)) return;
      if (res.data) {
        applyConfig(set, res.data);
      }
      set({ loading: false });
    } catch (err) {
      if (isStale(gen)) return;
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  patchShortcuts: async (delta) => {
    const gen = currentGen();
    try {
      const res = await api.patchConfig({ shortcuts: { ...get().shortcuts, ...delta } });
      if (isStale(gen)) return false;
      if (res.data) {
        applyConfig(set, res.data);
        if (delta.global_invoke !== undefined) {
          await syncGlobalShortcutWithMain(delta.global_invoke);
        }
        set({ error: null });
        return true;
      }
      return false;
    } catch (err) {
      if (isStale(gen)) return false;
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  resetShortcuts: async () => {
    const gen = currentGen();
    try {
      const res = await api.patchConfig({ shortcuts: DEFAULT_SHORTCUTS });
      if (isStale(gen)) return false;
      if (res.data) {
        applyConfig(set, res.data);
        await syncGlobalShortcutWithMain(DEFAULT_SHORTCUTS.global_invoke);
        return true;
      }
      return false;
    } catch (err) {
      if (isStale(gen)) return false;
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  patchFont: (delta) =>
    runSimplePatch(set, () => api.patchConfig({ font: { ...get().font, ...delta } })),
  patchWindow: (delta) =>
    runSimplePatch(set, () => api.patchConfig({ window: { ...get().window, ...delta } })),
  patchLlm: (delta) =>
    runSimplePatch(set, () => api.patchConfig({ llm: { ...get().llm, ...delta } })),
  patchTrash: (delta) =>
    runSimplePatch(set, () => api.patchConfig({ trash: { ...get().trash, ...delta } })),
  patchEditor: (delta) =>
    runSimplePatch(set, () => api.patchConfig({ editor: { ...get().editor, ...delta } })),
  patchBrowser: (delta) =>
    runSimplePatch(set, () => api.patchConfig({ browser: { ...get().browser, ...delta } })),
  patchAi: (delta) => runSimplePatch(set, () => api.patchConfig({ ai: { ...get().ai, ...delta } })),
  patchLog: (delta) =>
    runSimplePatch(set, () => api.patchConfig({ log: { ...get().log, ...delta } })),

  reset: () => {
    applyFontToRoot(DEFAULT_FONT);
    set({
      config: null,
      shortcuts: DEFAULT_SHORTCUTS,
      font: DEFAULT_FONT,
      window: DEFAULT_WINDOW,
      llm: DEFAULT_LLM,
      trash: DEFAULT_TRASH,
      editor: DEFAULT_EDITOR,
      browser: DEFAULT_BROWSER,
      ai: DEFAULT_AI,
      log: DEFAULT_LOG,
      loading: false,
      error: null,
    });
  },
}));

export {
  DEFAULT_SHORTCUTS,
  DEFAULT_FONT,
  DEFAULT_WINDOW,
  DEFAULT_LLM,
  DEFAULT_TRASH,
  DEFAULT_EDITOR,
  DEFAULT_BROWSER,
  DEFAULT_AI,
  DEFAULT_LOG,
};
