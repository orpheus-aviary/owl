import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import { loadConfig } from '@owl/core';
import { BrowserWindow, app, shell } from 'electron';
import { checkDaemon, spawnDaemon } from './daemon.js';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  // Read window size from config so user customisations take effect next launch.
  let width = 1000;
  let height = 700;
  try {
    const cfg = loadConfig();
    if (cfg.window.width > 0) width = cfg.window.width;
    if (cfg.window.height > 0) height = cfg.window.height;
  } catch {
    // Fall through to hardcoded defaults if config is unreadable.
  }

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 600,
    minHeight: 400,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Prevent in-app navigation for external URLs
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? '';
    if (is.dev && rendererUrl && url.startsWith(rendererUrl)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(async () => {
  // Auto-start daemon if not running
  const running = await checkDaemon();
  if (!running) {
    spawnDaemon();
    // Wait for daemon to be ready
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await checkDaemon()) break;
    }
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
