import { toElectronAccelerator } from '@owl/core';
import { BrowserWindow, app, globalShortcut } from 'electron';

/**
 * Electron `globalShortcut` integration. Keeps `currentAccelerator` so we
 * can unregister the previous binding before applying a new one on rebind.
 * Empty / malformed input disables registration without throwing — bad
 * user config shouldn't kill the main process. Failures (binding taken
 * by another app, malformed canonical) log to console and otherwise
 * silently drop; users can pick a different key if their first choice
 * doesn't work.
 */

let currentAccelerator: string | null = null;

function showAndFocus(): void {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length === 0) return;
  const win = wins[0];
  // macOS: `app.show()` reveals all windows hidden via Cmd+H. Safe to call
  // when already visible. No-op on other platforms.
  if (process.platform === 'darwin') {
    app.show();
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/**
 * Register `canonical` as the global invoke shortcut, replacing any prior
 * binding. Empty string disables. Best-effort: failures are logged but
 * not surfaced — the user notices "shortcut doesn't fire" and picks
 * another key.
 */
export function setGlobalShortcut(canonical: string): void {
  if (currentAccelerator) {
    globalShortcut.unregister(currentAccelerator);
    currentAccelerator = null;
  }
  if (!canonical) return;
  const accel = toElectronAccelerator(canonical);
  if (!accel) {
    console.warn(`[global-shortcut] unparseable canonical form: ${canonical}`);
    return;
  }
  try {
    if (!globalShortcut.register(accel, showAndFocus)) {
      console.warn(`[global-shortcut] register returned false for ${accel} (likely taken)`);
      return;
    }
  } catch (err) {
    console.warn('[global-shortcut] register threw:', err);
    return;
  }
  currentAccelerator = accel;
}

/** Release all globalShortcut bindings. Call from app `will-quit`. */
export function unregisterGlobalShortcut(): void {
  globalShortcut.unregisterAll();
  currentAccelerator = null;
}
