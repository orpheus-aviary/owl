import { toElectronAccelerator } from '@owl/core';
import { BrowserWindow, app, globalShortcut } from 'electron';

/**
 * Electron `globalShortcut` integration. Keeps `currentAccelerator` so we
 * can unregister the previous binding before applying a new one on rebind.
 * Empty / malformed input disables registration without throwing — bad
 * user config shouldn't kill the main process.
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

export interface SetGlobalShortcutResult {
  ok: boolean;
  accelerator: string | null;
  error?: string;
}

/**
 * Register `canonical` as the global invoke shortcut, replacing any prior
 * binding. Empty string disables. Returns success + the resolved Electron
 * accelerator (for logging / UI feedback) or a localized error message
 * when registration fails (e.g. binding taken by another app).
 */
export function setGlobalShortcut(canonical: string): SetGlobalShortcutResult {
  if (currentAccelerator) {
    globalShortcut.unregister(currentAccelerator);
    currentAccelerator = null;
  }
  if (!canonical) {
    return { ok: true, accelerator: null };
  }
  const accel = toElectronAccelerator(canonical);
  if (!accel) {
    return { ok: false, accelerator: null, error: `无法解析快捷键格式：${canonical}` };
  }
  let registered = false;
  try {
    registered = globalShortcut.register(accel, showAndFocus);
  } catch (err) {
    return {
      ok: false,
      accelerator: accel,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!registered) {
    return {
      ok: false,
      accelerator: accel,
      error: `快捷键 ${accel} 注册失败，可能已被其他应用占用`,
    };
  }
  currentAccelerator = accel;
  return { ok: true, accelerator: accel };
}

/** Release all globalShortcut bindings. Call from app `will-quit`. */
export function unregisterGlobalShortcut(): void {
  globalShortcut.unregisterAll();
  currentAccelerator = null;
}
