// Platform adapter — the single seam between the React renderer and its host.
//
// The same renderer bundle runs in two hosts: the Electron renderer (where a
// preload script injects `window.owlAPI`) and, from Phase B, a plain browser
// (where there is no preload). Components must never touch `window.owlAPI`
// directly — they go through `getPlatform()` so the web host can supply its
// own implementation. See `docs/plans/2026-06-12-step0-platform-adapter-shared.md`.

import type { OwlAPI, StartupMode } from '@/types/owl-api';

type SyncApi = OwlAPI['sync'];

/**
 * Session / status operations the web client WILL gain over HTTP in Phase A —
 * present on every adapter. The web stub returns a typed `{ ok: false }`
 * failure until that lands, so callers (which already branch on `reply.ok`)
 * need no change.
 */
type RequiredSync = Pick<
  SyncApi,
  'login' | 'logout' | 'status' | 'run' | 'devices' | 'revokeDevice'
>;

/**
 * Electron-local multi-profile management + IPC-push subscriptions. The web
 * host has no equivalent (one browser session ↔ one cloud daemon = one
 * profile), so these are optional and absent on the web adapter — components
 * guard with `cap?.()`.
 */
type OptionalSync = Partial<
  Pick<
    SyncApi,
    | 'profiles'
    | 'switchProfile'
    | 'deleteProfile'
    | 'onProfileSwitched'
    | 'onClaimPrompt'
    | 'respondClaim'
  >
>;

export type SyncCapability = RequiredSync & OptionalSync;

export interface PlatformAdapter {
  /** Startup branch. Web is always `{ mode: 'normal' }` — no local DB migration. */
  readonly startupMode: StartupMode;
  /** Daemon HTTP base. Electron: per-profile injected port; web: `''` (same-origin). */
  daemonBaseUrl(): string;
  /** Sync surface — required session ops + optional Electron-local profile mgmt. */
  readonly sync: SyncCapability;
  /** Electron-only app-shell capabilities; `undefined` in the web host. */
  readonly migration?: OwlAPI['migration'];
  readonly cli?: OwlAPI['cli'];
  readonly shortcut?: OwlAPI['shortcut'];
  readonly quit?: OwlAPI['quit'];
}
