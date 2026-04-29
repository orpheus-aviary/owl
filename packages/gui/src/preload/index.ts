import { contextBridge, ipcRenderer } from 'electron';

type StartupMode =
  | { mode: 'normal' }
  | { mode: 'migrate-required'; dbPath: string }
  | { mode: 'incompatible'; dbPath: string; dbVersion: number; maxSupported: number };

type MigratePhase = 'backup' | 'copy' | 'fts-rebuild' | 'swap';

type MigrationStartResult =
  | {
      ok: true;
      backupPath: string;
      notesCount: number;
      elapsedMs: number;
      alreadyMigrated?: boolean;
    }
  | { ok: false; reason: string; message: string };

/**
 * Parse --startup-mode=<json> from process.argv. additionalArguments are
 * appended by main/window.ts when the window is constructed in migration
 * mode; absent → renderer boots the main app.
 *
 * Malformed JSON falls through to 'normal' instead of throwing — we don't
 * want a preload-script crash to strand the user in a blank renderer.
 */
function parseStartupMode(): StartupMode {
  const prefix = '--startup-mode=';
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return { mode: 'normal' };
  try {
    return JSON.parse(arg.slice(prefix.length)) as StartupMode;
  } catch {
    return { mode: 'normal' };
  }
}

contextBridge.exposeInMainWorld('owlAPI', {
  daemonUrl: 'http://127.0.0.1:47010',
  startupMode: parseStartupMode(),

  migration: {
    start: (): Promise<MigrationStartResult> => ipcRenderer.invoke('migration:start'),

    onProgress: (cb: (phase: MigratePhase) => void): (() => void) => {
      const listener = (_: unknown, phase: MigratePhase) => cb(phase);
      ipcRenderer.on('migration:progress', listener);
      return () => ipcRenderer.off('migration:progress', listener);
    },

    onDaemonFailed: (cb: () => void): (() => void) => {
      const listener = () => cb();
      ipcRenderer.on('migration:daemon-failed', listener);
      return () => ipcRenderer.off('migration:daemon-failed', listener);
    },

    done: (): void => {
      ipcRenderer.send('migration:done');
    },

    quit: (): void => {
      ipcRenderer.send('migration:quit');
    },
  },
});
