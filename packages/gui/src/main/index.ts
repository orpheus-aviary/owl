import { loadConfig, paths } from '@owl/core';
import { BrowserWindow, app, ipcMain } from 'electron';
import { detectCli } from './cli-detect.js';
import { ensureDaemonRunning, getDaemonPort, stopDaemonGracefully } from './daemon.js';
import { setGlobalShortcut, unregisterGlobalShortcut } from './global-shortcut.js';
import { registerMigrationIpc } from './migration-ipc.js';
import type { StartupMode } from './migration-precheck.js';
import { runMigrationPrecheck } from './migration-precheck.js';
import { createWindow } from './window.js';

let isQuitting = false;
let pendingQuitCheck = false;
let pendingQuitResolve: ((proceed: boolean) => void) | null = null;
/**
 * Captured from the first migration precheck and read by `before-quit`.
 * When set to anything other than 'normal', the unsaved-tabs IPC is
 * skipped — MigrationDialog doesn't have a dirty-tabs concept and its
 * renderer doesn't listen for `quit:check-unsaved`, so asking would
 * just eat the 10s timeout before the app could exit.
 */
let currentStartupMode: StartupMode['mode'] = 'normal';

/** Milliseconds the main process will wait for the renderer to finish the
 *  unsaved-tab dialog flow before defaulting to "proceed" and quitting.
 *  See design §2.3 — a stuck renderer shouldn't trap the user in Cmd+Q. */
const QUIT_CHECK_TIMEOUT_MS = 10_000;

function onWindowClose(event: Electron.Event, win: BrowserWindow): void {
  // Red-cross close: hide on macOS so dock icon + renderer state stay alive.
  if (!isQuitting && process.platform === 'darwin') {
    event.preventDefault();
    win.hide();
  }
}

/**
 * Ask the renderer (MainApp only — see `currentStartupMode` guard) whether
 * any tabs have unsaved work. Returns true when the renderer finishes the
 * dialog flow with no cancellation (or when there's no window / the check
 * times out after 10s).
 */
function askRendererAboutUnsaved(): Promise<boolean> {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return Promise.resolve(true);
  // Window may be hidden (macOS red-cross then Cmd+Q from dock). Bring it
  // back so the dialog is visible instead of drawing into thin air.
  if (!win.isVisible()) {
    win.show();
    win.focus();
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (proceed: boolean) => {
      if (settled) return;
      settled = true;
      pendingQuitResolve = null;
      resolve(proceed);
    };
    pendingQuitResolve = settle;
    win.webContents.send('quit:check-unsaved');
    setTimeout(() => {
      if (!settled) {
        console.warn('quit:check-unsaved timed out; proceeding without confirmation');
        settle(true);
      }
    }, QUIT_CHECK_TIMEOUT_MS);
  });
}

app.whenReady().then(async () => {
  const dbPath = paths.dbPath();
  const precheck = runMigrationPrecheck(dbPath);
  currentStartupMode = precheck.mode;

  // CLI detection: Settings → 高级 → CLI 工具 card asks for this on mount
  // and on manual refresh. Handler is cheap (~100-300ms) and idempotent.
  ipcMain.handle('cli:detect', () => detectCli());

  // Global shortcut rebind from Settings → 快捷键 → 全局唤起. Fire-and-
  // forget — setGlobalShortcut logs its own failures, the renderer does
  // not surface them to the user.
  ipcMain.handle('globalShortcut:set', (_e, canonical: string) => {
    setGlobalShortcut(canonical);
  });

  // Register the configured global shortcut at startup. setGlobalShortcut
  // is best-effort and logs its own failures.
  try {
    const cfg = loadConfig();
    setGlobalShortcut(cfg.shortcuts.global_invoke ?? '');
  } catch (err) {
    console.warn('global shortcut init skipped (config unreadable):', err);
  }

  // Renderer's UnsavedTabsDialog replies here once the user has walked
  // through every dirty tab (or cancelled). Stored resolver is set by
  // `askRendererAboutUnsaved` in the `before-quit` path.
  ipcMain.on('quit:response', (_e, proceed: boolean) => {
    pendingQuitResolve?.(proceed);
  });

  const daemonPort = getDaemonPort();

  if (precheck.mode === 'normal') {
    await ensureDaemonRunning();
    createWindow({ daemonPort, onClose: onWindowClose });
  } else {
    const win = createWindow({ startupMode: precheck, daemonPort, onClose: onWindowClose });
    registerMigrationIpc(win, dbPath, () => createWindow({ daemonPort, onClose: onWindowClose }));
  }

  app.on('activate', () => {
    const existing = BrowserWindow.getAllWindows();
    if (existing.length > 0) {
      existing[0].show();
    } else {
      // activate only fires on macOS after the app has a normal window,
      // which in MigrationDialog flow only happens post-migration. So it's
      // always safe to recreate in normal mode here.
      createWindow({ daemonPort, onClose: onWindowClose });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  // macOS: keep app alive in dock; red-cross only hides the window.
});

// Release globalShortcut registrations before exit. Without this, a stale
// binding can linger across dev restarts and block re-registration.
app.on('will-quit', () => {
  unregisterGlobalShortcut();
});

app.on('before-quit', async (event) => {
  if (isQuitting) return;
  event.preventDefault();
  // Guard against re-entry: second Cmd+Q while the dialog is up must not
  // clobber pendingQuitResolve or spin up another askRenderer round.
  if (pendingQuitCheck) return;
  pendingQuitCheck = true;
  try {
    // MigrationDialog has no unsaved-tabs concept and its renderer
    // doesn't listen for quit:check-unsaved — skip the IPC there.
    if (currentStartupMode === 'normal') {
      const proceed = await askRendererAboutUnsaved();
      if (!proceed) return; // user cancelled, app stays alive
    }
    isQuitting = true;
    try {
      await stopDaemonGracefully();
    } catch (err) {
      console.error('Error stopping daemon on quit:', err);
    }
    app.quit();
  } finally {
    pendingQuitCheck = false;
  }
});
