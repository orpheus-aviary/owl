// Electron host adapter — a thin, live pass-through over the preload-injected
// `window.owlAPI`. `getPlatform()` only constructs this when `window.owlAPI`
// is present, so the body may read it freely (no internal guard).
//
// Every field is a live getter rather than a captured value: vitest renderer
// tests mutate `window.owlAPI.*` between cases, and live reads keep the cached
// adapter in step with those mutations.

import type { PlatformAdapter } from './types';

export function createElectronAdapter(): PlatformAdapter {
  return {
    get startupMode() {
      return window.owlAPI.startupMode;
    },
    // Local daemon has no Layer-2 login (A6 adds a local mutating-token, not a
    // login gate), so the desktop never shows the web login screen.
    requiresAuth: false,
    daemonBaseUrl: () => window.owlAPI.daemonUrl,
    get sync() {
      return window.owlAPI.sync;
    },
    get migration() {
      return window.owlAPI.migration;
    },
    get cli() {
      return window.owlAPI.cli;
    },
    get shortcut() {
      return window.owlAPI.shortcut;
    },
    get quit() {
      return window.owlAPI.quit;
    },
  };
}
