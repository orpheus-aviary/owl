// Global type declaration for window.owlAPI, mirrored in preload/index.ts.
// Single source of truth — lib/api.ts's prior local `declare global`
// window.owlAPI block is removed in favor of this file.
//
// IMPORTANT: this file lives in renderer-land (src/renderer/src/types/). It
// MUST NOT import from `../../../main/*` — `tsconfig.web.json` does not
// include `src/main`, and dragging Electron / Node main modules into the
// web type-graph type-collapses the renderer build. All sync IPC types
// come from `src/shared/`.

import type { LoginAndOpenSessionInput } from '../../../shared/sync-auth-types.js';
import type { SyncDevicesReply } from '../../../shared/sync-devices-types.js';
import type { SyncIpcReply, SyncStatusReply } from '../../../shared/sync-status-types.js';

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
  shortcut: {
    setGlobal: (canonical: string) => Promise<void>;
  };
  quit: {
    onCheckUnsaved: (cb: () => void) => () => void;
    respond: (proceed: boolean) => void;
  };
  sync: {
    login: (input: LoginAndOpenSessionInput) => Promise<SyncIpcReply<void>>;
    logout: () => Promise<SyncIpcReply<void>>;
    status: () => Promise<SyncIpcReply<SyncStatusReply>>;
    devices: () => Promise<SyncIpcReply<SyncDevicesReply>>;
    onProfileSwitched: (cb: () => void) => () => void;
  };
}

declare global {
  interface Window {
    owlAPI: OwlAPI;
  }
}
