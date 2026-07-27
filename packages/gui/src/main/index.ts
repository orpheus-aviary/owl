import { loadConfig, resolveActiveProfileDbPath } from '@owl/core';
import { BrowserWindow, app, dialog, ipcMain, powerMonitor } from 'electron';
import { detectCli } from './cli-detect.js';
import { getLocalTokenPath } from './daemon-auth.js';
import {
  type DaemonReadiness,
  ensureDaemonRunning,
  getDaemonPort,
  stopDaemonByPid,
  stopDaemonGracefully,
} from './daemon.js';
import { setGlobalShortcut, unregisterGlobalShortcut } from './global-shortcut.js';
import { registerMigrationIpc } from './migration-ipc.js';
import type { StartupMode } from './migration-precheck.js';
import { runMigrationPrecheck } from './migration-precheck.js';
import { acquireSingleInstanceLock } from './single-instance.js';
import { onTimerRefreshResult, recoverIfAuthRequired } from './sync-auth-recovery.js';
import { setRefreshResultHandler } from './sync-auth-renewal.js';
import { maybeRefreshNow, restoreSessionOnStartup } from './sync-auth.js';
import { registerSyncIpc } from './sync-ipc.js';
import { createWindow } from './window.js';

// 0.6.2 W3 — a background renewal that refreshed but failed to hand the token
// to the daemon feeds the recovery module's retry loop instead of vanishing.
setRefreshResultHandler(onTimerRefreshResult);

// Acquire the single-instance lock as early as possible (Phase 21, layer A). A
// second launch quits here; the primary keeps booting and focuses its window on
// relaunch. `whenReady` is guarded so a losing instance does zero boot work.
const isPrimaryInstance = acquireSingleInstanceLock();

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

/**
 * A6 — ensure a compatible local daemon before the main window opens. Returns
 * true only when one is ready. On `failed`/`incompatible`/user-cancel it shows a
 * native dialog (window not created yet) and quits, returning false so the
 * caller does NOT open a main window that would only 401 every request.
 */
async function ensureNormalDaemon(): Promise<boolean> {
  const readiness = await ensureDaemonRunning();
  if (readiness.state === 'ready') return true;
  if (readiness.state === 'failed') {
    dialog.showMessageBoxSync({
      type: 'error',
      title: '无法启动后台服务',
      message: '无法启动 Owl 后台服务。',
      detail: '请稍后重试；如果问题持续，请重新安装或查看日志。',
      buttons: ['退出'],
    });
    app.quit();
    return false;
  }
  return handleIncompatibleDaemon(readiness);
}

async function handleIncompatibleDaemon(
  readiness: Extract<DaemonReadiness, { state: 'incompatible' }>,
): Promise<boolean> {
  // No pid in /status → a pre-A6 daemon we cannot prove the identity of, so we
  // must not signal any pid. Guide the user to stop it themselves.
  if (readiness.pid === undefined) {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: '检测到不兼容的后台服务',
      message: '检测到一个旧版本的 Owl 后台服务正在运行。',
      detail:
        '请完全退出旧版 Owl（含菜单栏 / Dock 图标）；如果它仍在运行，' +
        '在「活动监视器」中结束名为 Owl 的后台进程，然后重新启动本应用。',
      buttons: ['退出'],
    });
    app.quit();
    return false;
  }

  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: '检测到不兼容的后台服务',
    message: '检测到一个不兼容的 Owl 后台服务正在运行。',
    detail: '是否停止它并继续启动？正在进行的操作可能会中断。',
    buttons: ['停止并继续', '取消'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice !== 0) {
    app.quit();
    return false;
  }

  const stopped = await stopDaemonByPid(readiness.pid);
  if (!stopped) {
    dialog.showMessageBoxSync({
      type: 'error',
      title: '无法停止后台服务',
      message: '无法停止旧的 Owl 后台服务。',
      detail: '请在「活动监视器」中手动结束它，然后重新启动本应用。',
      buttons: ['退出'],
    });
    app.quit();
    return false;
  }

  const retry = await ensureDaemonRunning();
  if (retry.state === 'ready') return true;
  dialog.showMessageBoxSync({
    type: 'error',
    title: '无法启动后台服务',
    message: '停止旧服务后仍无法启动新的后台服务。',
    detail: '请稍后重试或查看日志。',
    buttons: ['退出'],
  });
  app.quit();
  return false;
}

app.whenReady().then(async () => {
  // A losing second instance has already been told to quit — do no boot work.
  if (!isPrimaryInstance) return;
  // P5-d Phase 12 (B6): resolve the active profile's db; falls back to the
  // legacy global db pre-migration, so this is behavior-preserving today.
  const dbPath = resolveActiveProfileDbPath();
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

  // P5-d Phase 8 — Settings → 同步 tab wiring: login / logout / status.
  registerSyncIpc();

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
  const daemonTokenPath = getLocalTokenPath();

  if (precheck.mode === 'normal') {
    // A6 — tri-state daemon check + native dialogs BEFORE any window. A false
    // return means a dialog was shown and the app is quitting; do not open a
    // main window that would only 401 every request.
    if (!(await ensureNormalDaemon())) return;
    // P5-d Phase 7 — daemon is ready; restore the encrypted skybridge session
    // into daemon's ctx via POST /sync/session. Best-effort: a missing toml /
    // locked keychain / partial config returns null silently; the user sees the
    // unauthenticated state and can log in from Settings. Never block on this.
    try {
      await restoreSessionOnStartup();
    } catch (err) {
      console.warn('skybridge session restore failed (continuing):', err);
    }
    createWindow({ daemonPort, daemonTokenPath, onClose: onWindowClose });
  } else {
    const win = createWindow({
      startupMode: precheck,
      daemonPort,
      daemonTokenPath,
      onClose: onWindowClose,
    });
    registerMigrationIpc(win, dbPath, () =>
      createWindow({ daemonPort, daemonTokenPath, onClose: onWindowClose }),
    );
  }

  // P5-d Phase 15b — keep the short-lived access token fresh. A scheduled
  // timer renews ~1min before expiry; these cover the gap when the machine
  // slept past the timer or the user returns after a long idle. maybeRefreshNow
  // is a cheap no-op unless the token is actually at/near expiry.
  //
  // 0.6.2 W3 — the same two moments also ask the daemon whether sync is stuck
  // on `auth_required` and kick off recovery. Renderer-driven recovery covers
  // the normal case, but with every window closed there is no renderer to
  // forward the status; this is the fallback that heals it anyway.
  powerMonitor.on('resume', () => {
    void maybeRefreshNow();
    void recoverIfAuthRequired();
  });
  app.on('browser-window-focus', () => {
    void maybeRefreshNow();
    void recoverIfAuthRequired();
  });

  app.on('activate', () => {
    const existing = BrowserWindow.getAllWindows();
    if (existing.length > 0) {
      existing[0].show();
    } else {
      // activate only fires on macOS after the app has a normal window,
      // which in MigrationDialog flow only happens post-migration. So it's
      // always safe to recreate in normal mode here.
      createWindow({ daemonPort, daemonTokenPath, onClose: onWindowClose });
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
