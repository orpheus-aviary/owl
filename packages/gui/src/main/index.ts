import { paths } from '@owl/core';
import { BrowserWindow, app } from 'electron';
import { ensureDaemonRunning, stopDaemonGracefully } from './daemon.js';
import { registerMigrationIpc } from './migration-ipc.js';
import { runMigrationPrecheck } from './migration-precheck.js';
import { createWindow } from './window.js';

let isQuitting = false;

function onWindowClose(event: Electron.Event, win: BrowserWindow): void {
  // Red-cross close: hide on macOS so dock icon + renderer state stay alive.
  if (!isQuitting && process.platform === 'darwin') {
    event.preventDefault();
    win.hide();
  }
}

app.whenReady().then(async () => {
  const dbPath = paths.dbPath();
  const precheck = runMigrationPrecheck(dbPath);

  if (precheck.mode === 'normal') {
    await ensureDaemonRunning();
    createWindow({ onClose: onWindowClose });
  } else {
    const win = createWindow({ startupMode: precheck, onClose: onWindowClose });
    registerMigrationIpc(win, dbPath, () => createWindow({ onClose: onWindowClose }));
  }

  app.on('activate', () => {
    const existing = BrowserWindow.getAllWindows();
    if (existing.length > 0) {
      existing[0].show();
    } else {
      // activate only fires on macOS after the app has a normal window,
      // which in MigrationDialog flow only happens post-migration. So it's
      // always safe to recreate in normal mode here.
      createWindow({ onClose: onWindowClose });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  // macOS: keep app alive in dock; red-cross only hides the window.
});

app.on('before-quit', async (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  try {
    await stopDaemonGracefully();
  } catch (err) {
    console.error('Error stopping daemon on quit:', err);
  }
  app.quit();
});
