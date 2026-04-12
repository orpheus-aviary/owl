import * as api from '@/lib/api';
import type { OwlConfig, ShortcutsConfig } from '@/lib/api';
import { create } from 'zustand';

// Fallback defaults — mirror @owl/core DEFAULT_CONFIG.shortcuts so that
// shortcut matching works during the initial fetch window before the
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

interface ConfigState {
  config: OwlConfig | null;
  shortcuts: ShortcutsConfig;
  loading: boolean;
  error: string | null;

  fetch: () => Promise<void>;
  patchShortcuts: (delta: Partial<ShortcutsConfig>) => Promise<boolean>;
  resetShortcuts: () => Promise<boolean>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  shortcuts: DEFAULT_SHORTCUTS,
  loading: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const res = await api.getConfig();
      if (res.data) {
        set({ config: res.data, shortcuts: res.data.shortcuts, loading: false });
      } else {
        set({ loading: false });
      }
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  patchShortcuts: async (delta) => {
    try {
      const res = await api.patchConfig({ shortcuts: { ...get().shortcuts, ...delta } });
      if (res.data) {
        set({ config: res.data, shortcuts: res.data.shortcuts });
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
        set({ config: res.data, shortcuts: res.data.shortcuts });
        return true;
      }
      return false;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  },
}));

export { DEFAULT_SHORTCUTS };
