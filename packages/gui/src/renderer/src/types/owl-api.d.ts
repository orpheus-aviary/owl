// Global type declaration for window.owlAPI, mirrored in preload/index.ts.
// Single source of truth — lib/api.ts's prior local `declare global`
// window.owlAPI block is removed in favor of this file.

export type StartupMode =
  | { mode: 'normal' }
  | { mode: 'migrate-required'; dbPath: string }
  | { mode: 'incompatible'; dbPath: string; dbVersion: number; maxSupported: number };

export type MigratePhase = 'backup' | 'copy' | 'fts-rebuild' | 'swap';

export type MigrationStartResult =
  | {
      ok: true;
      backupPath: string;
      notesCount: number;
      elapsedMs: number;
      alreadyMigrated?: boolean;
    }
  | { ok: false; reason: string; message: string };

export interface CliDetectResult {
  installed: boolean;
  path?: string;
  version?: string;
}

export interface OwlAPI {
  daemonUrl: string;
  startupMode: StartupMode;
  migration: {
    start: () => Promise<MigrationStartResult>;
    onProgress: (cb: (phase: MigratePhase) => void) => () => void;
    onDaemonFailed: (cb: () => void) => () => void;
    done: () => void;
    quit: () => void;
  };
  cli: {
    detect: () => Promise<CliDetectResult>;
  };
}

declare global {
  interface Window {
    owlAPI: OwlAPI;
  }
}
