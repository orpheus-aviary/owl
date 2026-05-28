import { contextBridge, ipcRenderer } from 'electron';
import type { LoginAndOpenSessionInput } from '../shared/sync-auth-types.js';
import type { SyncIpcReply, SyncStatusReply } from '../shared/sync-status-types.js';
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

  shortcut: {
    /**
     * Rebind the OS-level invoke shortcut. Pass canonical form like
     * `Mod-Alt-KeyO`; empty string disables. Fire-and-forget: main logs
     * its own failures, the renderer doesn't get feedback.
     */
    setGlobal: (canonical: string): Promise<void> =>
      ipcRenderer.invoke('globalShortcut:set', canonical),
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

  sync: {
    /**
     * Login to skybridge. Success returns `{ ok: true, data: undefined }` —
     * the resolved identity is intentionally NOT carried back; the
     * renderer is expected to `await sync.status()` afterwards. Single
     * display truth keeps display fields decoupled from login wire shape.
     */
    login: (input: LoginAndOpenSessionInput): Promise<SyncIpcReply<void>> =>
      ipcRenderer.invoke('sync:login', input),
    /**
     * Logout: revokes server-side token + clears daemon session + clears
     * encrypted toml `[auth] / [device] / [workspace]` (preserves
     * `[server].url` for next login default).
     */
    logout: (): Promise<SyncIpcReply<void>> => ipcRenderer.invoke('sync:logout'),
    /**
     * Identity + sync snapshot. `session === null` covers unauthenticated
     * AND keychain-unavailable cases (kept aligned with
     * `restoreSessionOnStartup`'s decrypt-probe gate so Settings can't
     * lie about "logged in" while next-boot restore would actually fail).
     */
    status: (): Promise<SyncIpcReply<SyncStatusReply>> => ipcRenderer.invoke('sync:status'),
  },
});
