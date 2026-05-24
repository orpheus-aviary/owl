import { join } from 'node:path';
import { is } from '@electron-toolkit/utils';
import { loadConfig } from '@owl/core';
import { BrowserWindow, shell } from 'electron';
import type { StartupMode } from './migration-precheck.js';

export interface CreateWindowOptions {
  /**
   * When present, passed to preload via `webPreferences.additionalArguments`
   * so the renderer can read `window.owlAPI.startupMode` synchronously on
   * first render. Absent → the renderer defaults to `{ mode: 'normal' }` and
   * mounts the main app.
   */
  startupMode?: StartupMode;
  /**
   * P5-c G1: the daemon port the main process is using (resolved from
   * `OWL_DAEMON_PORT` env or default 47010). Pushed to preload via
   * `additionalArguments = ['--daemon-port=<port>']` so the renderer's
   * `window.owlAPI.daemonUrl` tracks main's spawn port. Absent → preload
   * falls back to 47010 (defensive; main always passes it in practice).
   */
  daemonPort?: number;
  /**
   * Called on every renderer 'close' event. main/index.ts wires this to the
   * shared `isQuitting` state so red-cross hides the window on macOS but
   * Cmd+Q still lets it close.
   */
  onClose?: (event: Electron.Event, win: BrowserWindow) => void;
}

export function createWindow(options: CreateWindowOptions = {}): BrowserWindow {
  let width = 1000;
  let height = 700;
  try {
    const cfg = loadConfig();
    if (cfg.window.width > 0) width = cfg.window.width;
    if (cfg.window.height > 0) height = cfg.window.height;
  } catch {
    // Fall through to hardcoded defaults if config is unreadable.
  }

  const additionalArguments: string[] = [];
  if (options.startupMode) {
    additionalArguments.push(`--startup-mode=${JSON.stringify(options.startupMode)}`);
  }
  if (options.daemonPort !== undefined) {
    additionalArguments.push(`--daemon-port=${options.daemonPort}`);
  }

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 600,
    minHeight: 400,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      additionalArguments,
    },
  });

  win.on('ready-to-show', () => win.show());

  if (options.onClose) {
    win.on('close', (event) => options.onClose?.(event, win));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? '';
    if (is.dev && rendererUrl && url.startsWith(rendererUrl)) return;
    if (url.startsWith('file://')) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}
