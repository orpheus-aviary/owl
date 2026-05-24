import { contextBridge, ipcRenderer } from 'electron';
import { daemonUrlFromArgv, parseStartupMode } from './args.js';

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

interface CliDetectResult {
  installed: boolean;
  path?: string;
  version?: string;
}

contextBridge.exposeInMainWorld('owlAPI', {
  // P5-c G1: main process injects `--daemon-port=<port>` via BrowserWindow
  // additionalArguments so OWL_DAEMON_PORT env / multi-profile setups
  // reach the renderer. Fallback 47010 keeps the prior hard-coded behavior
  // if main forgot to inject (defensive — should not happen in practice).
  daemonUrl: daemonUrlFromArgv(process.argv),
  startupMode: parseStartupMode(process.argv),

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

  cli: {
    /**
     * Probe the user's shell PATH (with Homebrew / nvm / npm-global
     * fallbacks) for the owl CLI binary. Called by Settings → 高级 on
     * mount and on "重新检测"; latency ~100–300 ms.
     */
    detect: (): Promise<CliDetectResult> => ipcRenderer.invoke('cli:detect'),
  },

  quit: {
    /**
     * Subscribe to the main process's "Cmd+Q fired, got any unsaved
     * work?" signal. MainApp mounts exactly one listener; the
     * UnsavedTabsDialog drives the per-tab prompt from there and calls
     * `respond` when the user has finished walking the queue (or
     * cancelled). Returns an unsubscribe function.
     */
    onCheckUnsaved: (cb: () => void): (() => void) => {
      const listener = () => cb();
      ipcRenderer.on('quit:check-unsaved', listener);
      return () => ipcRenderer.off('quit:check-unsaved', listener);
    },
    /**
     * Reply to the most recent `quit:check-unsaved`. Pass true to let the
     * main process continue its stopDaemon + app.quit sequence; false to
     * cancel the quit entirely.
     */
    respond: (proceed: boolean): void => {
      ipcRenderer.send('quit:response', proceed);
    },
  },
});
