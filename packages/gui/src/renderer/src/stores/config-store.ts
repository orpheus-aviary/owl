import * as api from '@/lib/api';
import type { OwlConfig, ShortcutsConfig } from '@/lib/api';
import { create } from 'zustand';

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
};

const DEFAULT_FONT: OwlConfig['font'] = {
  global_offset: 0,
  editor_font_size: 14,
  editor_line_height: 1.6,
};

const DEFAULT_WINDOW: OwlConfig['window'] = { width: 1000, height: 700 };

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
  loading: boolean;
  error: string | null;

  fetch: () => Promise<void>;
  patchShortcuts: (delta: Partial<ShortcutsConfig>) => Promise<boolean>;
  resetShortcuts: () => Promise<boolean>;
  patchFont: (delta: Partial<OwlConfig['font']>) => Promise<boolean>;
  patchWindow: (delta: Partial<OwlConfig['window']>) => Promise<boolean>;
}

function applyConfig(set: (update: Partial<ConfigState>) => void, config: OwlConfig): void {
  applyFontToRoot(config.font);
  set({
    config,
    shortcuts: config.shortcuts,
    font: config.font,
    window: config.window,
  });
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  shortcuts: DEFAULT_SHORTCUTS,
  font: DEFAULT_FONT,
  window: DEFAULT_WINDOW,
  loading: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.getConfig();
      if (res.data) {
        applyConfig(set, res.data);
      }
      set({ loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  patchShortcuts: async (delta) => {
    try {
      const res = await api.patchConfig({ shortcuts: { ...get().shortcuts, ...delta } });
      if (res.data) {
        applyConfig(set, res.data);
        return true;
      }
      return false;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  resetShortcuts: async () => {
    try {
      const res = await api.patchConfig({ shortcuts: DEFAULT_SHORTCUTS });
      if (res.data) {
        applyConfig(set, res.data);
        return true;
      }
      return false;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  patchFont: async (delta) => {
    try {
      const res = await api.patchConfig({ font: { ...get().font, ...delta } });
      if (res.data) {
        applyConfig(set, res.data);
        return true;
      }
      return false;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },

  patchWindow: async (delta) => {
    try {
      const res = await api.patchConfig({ window: { ...get().window, ...delta } });
      if (res.data) {
        applyConfig(set, res.data);
        return true;
      }
      return false;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },
}));

export { DEFAULT_SHORTCUTS, DEFAULT_FONT, DEFAULT_WINDOW };
