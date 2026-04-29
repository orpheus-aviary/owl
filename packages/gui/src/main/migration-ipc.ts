// IPC wiring for the MigrationDialog flow.
//
// Events (5):
//   migration:start         invoke → ok | {reason, message}
//   migration:progress      send   → phase ('backup' | 'copy' | 'fts-rebuild' | 'swap')
//   migration:done          send   → triggers daemon spawn + window destroy+recreate
//                                      (or migration:daemon-failed if the spawn fails)
//   migration:quit          send   → app.quit()
//   migration:daemon-failed send   → renderer shows success-screen daemon-failed banner
//
// mapMigrationError() is exported as a pure function so its 7 cases can be
// covered by a unit test without having to stub ipcMain / BrowserWindow.

import {
  IncompatibleDbError,
  type MigrateResult,
  MigrationBusyError,
  SchemaMismatchError,
  SourceDbCorruptionError,
  migrateLegacyDb,
} from '@owl/core';
import { type BrowserWindow, app, ipcMain } from 'electron';
import { ensureDaemonRunning } from './daemon.js';

export type MigrationStartResult =
  | ({ ok: true } & MigrateResult)
  | { ok: false; reason: string; message: string };

/**
 * Pure mapping from a thrown migration error (any value) to the renderer
 * payload shape. Exported for direct unit testing.
 */
export function mapMigrationError(err: unknown): {
  ok: false;
  reason: string;
  message: string;
} {
  if (err instanceof MigrationBusyError) {
    return { ok: false, reason: err.reason, message: err.message };
  }
  if (err instanceof SourceDbCorruptionError) {
    return {
      ok: false,
      reason: 'source_db_corruption',
      message: `源库发现 ${err.violations} 条孤立外键引用，无法自动修复。原库未变动。`,
    };
  }
  if (err instanceof SchemaMismatchError) {
    return {
      ok: false,
      reason: 'schema_mismatch',
      message: `源库 schema 不符合预期：${err.details}。原库未变动。`,
    };
  }
  if (err instanceof IncompatibleDbError) {
    return {
      ok: false,
      reason: 'incompatible',
      message: `数据库 v${err.dbVersion} 来自更新版本应用（本版本支持到 v${err.maxSupported}），请升级 Owl。`,
    };
  }
  if (err instanceof Error) {
    return { ok: false, reason: 'unknown', message: err.message };
  }
  return { ok: false, reason: 'unknown', message: String(err) };
}

/**
 * Register the 5 migration IPC endpoints. Called once per migration-mode
 * window; the renderer tears these down by destroying the window, so no
 * explicit ipcMain.removeHandler is needed.
 *
 * `createPostMigrationWindow` is injected from main/index.ts so the recreated
 * window inherits the same onClose (red-cross hide on macOS) as the normal
 * boot path — avoids a circular import between index.ts and this module.
 */
export function registerMigrationIpc(
  win: BrowserWindow,
  dbPath: string,
  createPostMigrationWindow: () => void,
): void {
  ipcMain.handle('migration:start', async (): Promise<MigrationStartResult> => {
    try {
      const result = await migrateLegacyDb(dbPath, {
        onProgress: (phase) => {
          if (!win.isDestroyed()) {
            win.webContents.send('migration:progress', phase);
          }
        },
      });
      return { ok: true, ...result };
    } catch (err) {
      return mapMigrationError(err);
    }
  });

  ipcMain.on('migration:done', async () => {
    const daemonOk = await ensureDaemonRunning();
    if (!daemonOk) {
      if (!win.isDestroyed()) {
        win.webContents.send('migration:daemon-failed');
      }
      return;
    }

    // Destroy + recreate rather than reload: additionalArguments are baked
    // into the renderer's process.argv at window creation time. A reload
    // would re-run preload in the same renderer process and pick up the old
    // `--startup-mode=migrate-required` flag, bouncing the user back to
    // MigrationDialog forever. A fresh BrowserWindow means fresh argv.
    if (!win.isDestroyed()) win.destroy();
    createPostMigrationWindow();
  });

  ipcMain.on('migration:quit', () => {
    app.quit();
  });
}
