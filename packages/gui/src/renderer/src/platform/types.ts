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
    // 0.6.2 W3 — desktop-only: the credentials live in GUI main's keychain.
    // A web client's session is owned by the cloud daemon, which recovers
    // itself (refresh-on-401), so there is nothing for the browser to do.
    | 'requestRecovery'
  >
>;

export type SyncCapability = RequiredSync & OptionalSync;

export interface PlatformAdapter {
  /** Startup branch. Web is always `{ mode: 'normal' }` — no local DB migration. */
  readonly startupMode: StartupMode;
  /**
   * Phase B (B1) — whether this host gates the app behind a login screen. The
   * web host talks to a cloud daemon that 401s without a bearer, so it must log
   * in first (`true`). Electron's local daemon has no Layer-2 auth (`false`),
   * so the desktop renders straight into the app — unchanged.
   */
  readonly requiresAuth: boolean;
  /**
   * Phase B (B2) — whether this host is a networked thin client over a
   * possibly-shared daemon, rather than the sole local writer. The web host
   * (`true`) opts into optimistic-concurrency saves (`expected_updated_at` +
   * 409 handling) and the `beforeunload` unsaved-tabs guard; Electron talks to
   * its own local daemon as the only writer (`false`), so it keeps
   * last-write-wins + manual save — desktop behavior unchanged.
   */
  readonly remoteClient: boolean;
  /** Daemon HTTP base. Electron: per-profile injected port; web: `''` (same-origin). */
  daemonBaseUrl(): string;
  /**
   * Phase A A6 — the local daemon's current CSRF token (Electron host only),
   * re-read per call so a daemon restart (token rotation) is picked up. Absent
   * on the web host, which authenticates with a Layer-2 session bearer instead.
   */
  getDaemonToken?(): string | null;
  /** Sync surface — required session ops + optional Electron-local profile mgmt. */
  readonly sync: SyncCapability;
  /** Electron-only app-shell capabilities; `undefined` in the web host. */
  readonly migration?: OwlAPI['migration'];
  readonly cli?: OwlAPI['cli'];
  readonly shortcut?: OwlAPI['shortcut'];
  readonly quit?: OwlAPI['quit'];
}
