/**
 * P5-d Phase 21 (layer A) — Electron single-instance lock.
 *
 * A second `owl` launch must not spin up a rival main process: two daemons
 * would fight for the same port, and two profile-switch orchestrators could
 * race the same `skybridge_config.toml` + db. We grab the OS-level lock; if a
 * primary instance already holds it we hand the launch off (focus its window)
 * and quit this one.
 */

import { BrowserWindow, app } from 'electron';

/**
 * Acquire the single-instance lock.
 *
 * @returns `true` if this is the primary instance (continue booting); `false`
 *   if another instance already holds the lock — the caller must skip ALL boot
 *   work (we've already asked the app to quit).
 */
export function acquireSingleInstanceLock(): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  // Relaunch attempts surface here on the primary instance — surface its window.
  app.on('second-instance', focusPrimaryWindow);
  return true;
}

function focusPrimaryWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}
