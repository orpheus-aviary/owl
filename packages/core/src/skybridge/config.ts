/**
 * P5-a Step 6 / P5-d Phase 13 — skybridge client config persistence.
 *
 * Stores the owl-side state needed to talk to a skybridge server:
 * `[server].url`, `[auth].user_id/token/email`, the auto-registered
 * `[device]`, and the resolved `[workspace]`. NOT the skybridge server's
 * own `server.toml` (which lives in the skybridge repo working dir and
 * configures the server process itself) — see design §5.1.
 *
 * Read / write semantics (design §5):
 *  - File at `~/orpheus-aviary-nest/skybridge/skybridge_config.toml`
 *  - Created by `POST /sync/login` first-success; daemon never creates
 *    on boot
 *  - Daemon re-reads on every sync request — no in-process cache beyond
 *    the request
 *  - Writes `chmod 600`; we don't keep a temp+rename atomic path here
 *  - `sync_cursor` lives in sqlite, not here, so `owl sync reset` doesn't
 *    need to touch this file
 *
 * Phase 13 — schema v2 (per-profile). The toml may now carry
 * `active_profile` + `[profiles.<id>]` sections. `readSkybridgeConfig`
 * returns the **active profile's** view when the shared `resolveActiveProfile`
 * gate passes (id valid + section present + profile db on disk), else the
 * legacy top-level `[auth]` view — same `SkybridgeConfig` shape either way,
 * so the 14 callers are untouched (D10/B10). Phase 13 is plumbing-only: the
 * v2 writers exist + are tested but no live path calls them yet (login flip
 * is Phase 15).
 *
 * Token storage is plaintext for the legacy path; GUI main writes
 * `encrypted_token` (safeStorage) via the Phase 7 keychain path.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { profileDbPath, skybridgeConfigPath } from '../config/paths.js';
import {
  LOCAL_PROFILE,
  isHexProfileId,
  isValidProfileId,
  resolveActiveProfile,
} from '../profile/resolver.js';

// ─── Types ──────────────────────────────────────────────

export interface SkybridgeServerSection {
  url: string;
}

export interface SkybridgeAuthSection {
  user_id: string;
  /**
   * Only used by `owl sync config show`; never sent on the wire.
   */
  email: string;
  /**
   * Legacy plaintext token from pre-P5-d-Phase-7 logins. Now optional —
   * GUI main writes `encrypted_token` instead. Daemon's `requireAuth`
   * narrowing still demands this field, so an encrypted-only toml is
   * NOT directly daemon-authenticatable; the session must arrive via
   * GUI main → /sync/session HTTP injection. Phase 9 deletes this
   * field outright once the encrypted path has full coverage.
   */
  token?: string;
  /**
   * P5-d Phase 7 — `safeStorage.encryptString(plaintext_token)` → base64.
   * Only GUI main writes this. Daemon **never** decrypts (it has no
   * Electron handle); the plaintext token only ever exists in GUI
   * main's local scope between decrypt and the POST /sync/session call.
   */
  encrypted_token?: string;
}

export interface SkybridgeDeviceSection {
  id: string;
  name: string;
  app_version: string;
  client_version: string;
}

export interface SkybridgeWorkspaceSection {
  id: string;
  slug: string;
}

export interface SkybridgeConfig {
  server: SkybridgeServerSection;
  auth?: SkybridgeAuthSection;
  device?: SkybridgeDeviceSection;
  workspace?: SkybridgeWorkspaceSection;
}

/**
 * Phase 13 schema-v2 — the flat-fields shape a `[profiles.<id>]` section is
 * written/read as. `server_url` is the connection address (mutable; not part
 * of the profile id). `server_id` is the Phase 15 anchor (left empty in
 * Phase 13 — no live writer). Secrets live in `encrypted_token`, which hits
 * the Phase 12 redact glob `*.profiles.*.encrypted_token`.
 */
export interface ProfileConfigSection {
  /** Phase 15 fills this from the server; Phase 13 leaves it empty. */
  server_id?: string;
  server_url: string;
  user_id?: string;
  email?: string;
  token?: string;
  encrypted_token?: string;
  device?: SkybridgeDeviceSection;
  workspace?: SkybridgeWorkspaceSection;
}

/** Raw `[profiles.<id>]` section as parsed off disk (everything optional). */
interface RawProfileSection {
  server_id?: string;
  server_url?: string;
  user_id?: string;
  email?: string;
  token?: string;
  encrypted_token?: string;
  device?: Partial<SkybridgeDeviceSection>;
  workspace?: Partial<SkybridgeWorkspaceSection>;
}

/** Raw whole-file shape (legacy top-level sections + v2 profiles). */
interface RawConfig {
  active_profile?: string;
  server?: { url?: string };
  auth?: { user_id?: string; email?: string; token?: string; encrypted_token?: string };
  device?: Partial<SkybridgeDeviceSection>;
  workspace?: Partial<SkybridgeWorkspaceSection>;
  profiles?: Record<string, RawProfileSection>;
}

/**
 * Normalized intermediate both the legacy and profile paths produce, so
 * `assembleConfig` validates + builds the public `SkybridgeConfig` from a
 * single place (no drift between the two shapes).
 */
interface ConfigSource {
  server?: { url?: string };
  auth?: { user_id?: string; email?: string; token?: string; encrypted_token?: string };
  device?: Partial<SkybridgeDeviceSection>;
  workspace?: Partial<SkybridgeWorkspaceSection>;
}

// ─── Errors ─────────────────────────────────────────────

export class SkybridgeNotConfiguredError extends Error {
  readonly code = 'SKYBRIDGE_NOT_CONFIGURED';
  constructor(public readonly path: string) {
    super(`skybridge config not found at ${path} — run "owl sync login" to create it`);
    this.name = 'SkybridgeNotConfiguredError';
  }
}

export class SkybridgeServerUrlMissingError extends Error {
  readonly code = 'SKYBRIDGE_SERVER_URL_MISSING';
  constructor(public readonly path: string) {
    super(`skybridge config at ${path} is missing [server].url`);
    this.name = 'SkybridgeServerUrlMissingError';
  }
}

export class SkybridgeAuthRequiredError extends Error {
  readonly code = 'SKYBRIDGE_AUTH_REQUIRED';
  constructor(message = 'skybridge auth missing — run "owl sync login"') {
    super(message);
    this.name = 'SkybridgeAuthRequiredError';
  }
}

/** A profile-writer was handed an id that isn't 32-hex (and isn't `local`). */
export class InvalidProfileIdError extends Error {
  readonly code = 'SKYBRIDGE_INVALID_PROFILE_ID';
  constructor(public readonly profileId: string) {
    super(`invalid skybridge profile id: ${JSON.stringify(profileId)}`);
    this.name = 'InvalidProfileIdError';
  }
}

/** Refused to activate a profile whose db doesn't exist on disk. */
export class ProfileDbMissingError extends Error {
  readonly code = 'SKYBRIDGE_PROFILE_DB_MISSING';
  constructor(public readonly profileId: string) {
    super(`cannot activate profile ${profileId}: its db does not exist`);
    this.name = 'ProfileDbMissingError';
  }
}

// ─── Path helper ────────────────────────────────────────

export { skybridgeConfigPath };

// ─── Read ───────────────────────────────────────────────

/** Map a v2 profile section onto the normalized source shape. */
function profileSrc(section: RawProfileSection): ConfigSource {
  return {
    server: { url: section.server_url },
    auth: {
      user_id: section.user_id,
      email: section.email,
      token: section.token,
      encrypted_token: section.encrypted_token,
    },
    device: section.device,
    workspace: section.workspace,
  };
}

/** Map the legacy top-level sections onto the normalized source shape. */
function legacySrc(raw: RawConfig): ConfigSource {
  return { server: raw.server, auth: raw.auth, device: raw.device, workspace: raw.workspace };
}

/**
 * Build the public `SkybridgeConfig` from a normalized source, applying the
 * same validation (server url required) + partial-section drops to both the
 * legacy and profile paths.
 */
function assembleConfig(src: ConfigSource, filePath: string): SkybridgeConfig {
  const url = src.server?.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new SkybridgeServerUrlMissingError(filePath);
  }
  const config: SkybridgeConfig = { server: { url } };
  // Accept either the legacy plaintext `token` or the new `encrypted_token`;
  // user_id + email remain required (non-secret display fields).
  const hasAnyToken = Boolean(src.auth?.token) || Boolean(src.auth?.encrypted_token);
  if (src.auth?.user_id && src.auth?.email && hasAnyToken) {
    config.auth = { user_id: src.auth.user_id, email: src.auth.email };
    if (src.auth.token) config.auth.token = src.auth.token;
    if (src.auth.encrypted_token) config.auth.encrypted_token = src.auth.encrypted_token;
  }
  if (src.device?.id) {
    config.device = {
      id: src.device.id,
      name: src.device.name ?? '',
      app_version: src.device.app_version ?? '',
      client_version: src.device.client_version ?? '',
    };
  }
  if (src.workspace?.id) {
    config.workspace = { id: src.workspace.id, slug: src.workspace.slug ?? '' };
  }
  return config;
}

/**
 * Load the client config from disk. Returns the parsed shape with
 * optional sections; the caller decides which conditions are fatal
 * (e.g. `requireAuth` narrows `auth` and throws if missing).
 *
 * Phase 13 — when `resolveActiveProfile` (the shared three-way gate) passes,
 * returns the active profile's view; otherwise the legacy top-level view. The
 * gate is the *same* one the db resolver uses, so config + db never disagree.
 *
 * Throws:
 *  - `SkybridgeNotConfiguredError` if the file does not exist
 *  - `SkybridgeServerUrlMissingError` if the resolved view has no server url
 */
export function readSkybridgeConfig(path?: string): SkybridgeConfig {
  const filePath = path ?? skybridgeConfigPath();
  if (!existsSync(filePath)) {
    throw new SkybridgeNotConfiguredError(filePath);
  }
  const raw = parse(readFileSync(filePath, 'utf-8')) as RawConfig;
  const active = resolveActiveProfile(filePath); // shared gate, same filePath (P1a/P2)
  if (active) {
    const section = raw.profiles?.[active.id];
    if (section == null) {
      // Defensive fail-closed: the gate already confirmed the section
      // exists, so reaching here means a TOCTOU race rewrote the file
      // between the two parses. Never silently drop to legacy — that's
      // the reverse split-brain (account session reading legacy auth).
      throw new SkybridgeNotConfiguredError(filePath);
    }
    return assembleConfig(profileSrc(section), filePath);
  }
  return assembleConfig(legacySrc(raw), filePath);
}

/**
 * Narrow `SkybridgeConfig` to one whose `auth.token` (plaintext) is
 * present.
 *
 * Daemon calls this right before issuing any authenticated client call.
 * 401 responses should call `clearSkybridgeAuth` so the next sync round
 * tells the user to re-login instead of looping with a dead token.
 *
 * P5-d Phase 7 — the narrow demands the plaintext `token` specifically,
 * NOT `encrypted_token`. Daemon has no Electron handle, so an
 * encrypted-only toml is intentionally not authenticatable through this
 * path. GUI main is responsible for decrypting and injecting the
 * session via POST /sync/session.
 */
export function requireAuth(
  config: SkybridgeConfig,
): SkybridgeConfig & { auth: SkybridgeAuthSection & { token: string } } {
  if (!config.auth?.token) throw new SkybridgeAuthRequiredError();
  return config as SkybridgeConfig & { auth: SkybridgeAuthSection & { token: string } };
}

// ─── Write ──────────────────────────────────────────────

/**
 * Full-file rewrite of a toml object + `chmod 600`. The token may be
 * plaintext, so we restrict permissions; on Windows the chmod is a no-op
 * (Node coerces it silently). Always full-file — we never patch a single
 * section in place, which keeps concurrent writes well-defined (last writer
 * wins instead of a mid-edit file).
 */
function writeRawConfig(filePath: string, obj: Record<string, unknown>): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, stringify(obj), 'utf-8');
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Permissions are best-effort; FS without unix bits (e.g. Windows)
    // silently rejects. We deliberately don't fail the write for that.
  }
}

/**
 * Raw read-modify-write: parse the whole existing file (tolerating a missing
 * or malformed one as `{}`), let `fn` mutate the raw object in place, then
 * rewrite. This is what keeps sibling `[profiles.*]` sections and
 * `active_profile` intact across a single-section edit (Phase 13 P2b).
 */
function mutateConfigFile(filePath: string, fn: (raw: Record<string, unknown>) => void): void {
  let raw: Record<string, unknown> = {};
  if (existsSync(filePath)) {
    try {
      const parsed = parse(readFileSync(filePath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt file → start from empty; the rewrite below repairs it.
    }
  }
  fn(raw);
  writeRawConfig(filePath, raw);
}

/**
 * Replace the on-disk config and `chmod 600` it. Legacy shape (top-level
 * `[server]`/`[auth]`/`[device]`/`[workspace]`). Live login/logout still
 * write through here in Phase 13; the v2 profile writers below are dormant
 * until Phase 15.
 */
export function writeSkybridgeConfig(config: SkybridgeConfig, path?: string): void {
  const filePath = path ?? skybridgeConfigPath();
  // smol-toml drops `undefined`-valued keys; optional sections show up only
  // when defined on the input — exactly the round-trip shape we want.
  const serialisable: Record<string, unknown> = { server: config.server };
  if (config.auth) serialisable.auth = config.auth;
  if (config.device) serialisable.device = config.device;
  if (config.workspace) serialisable.workspace = config.workspace;
  writeRawConfig(filePath, serialisable);
}

/**
 * Write (or replace) a `[profiles.<id>]` section, preserving every other
 * profile + `active_profile` (raw read-modify-write). `opts.setActive` also
 * points `active_profile` at it, but only after verifying the profile db
 * exists — we refuse to activate a ghost profile.
 *
 * Phase 13: dormant (no live caller); exists so the reader/writer stay
 * symmetric and Phase 15 can consume it directly.
 *
 * @throws InvalidProfileIdError  if `profileId` isn't 32-hex (rejects `local`)
 * @throws ProfileDbMissingError  if `setActive` but the profile db is absent
 */
export function writeProfileConfig(
  profileId: string,
  section: ProfileConfigSection,
  opts: { setActive?: boolean } = {},
  path?: string,
): void {
  if (!isHexProfileId(profileId)) throw new InvalidProfileIdError(profileId);
  if (opts.setActive && !existsSync(profileDbPath(profileId))) {
    throw new ProfileDbMissingError(profileId);
  }
  const filePath = path ?? skybridgeConfigPath();
  mutateConfigFile(filePath, (raw) => {
    if (!raw.profiles) raw.profiles = {};
    (raw.profiles as Record<string, unknown>)[profileId] = section;
    if (opts.setActive) raw.active_profile = profileId;
  });
}

/**
 * Point `active_profile` at an existing profile. `local` always activates
 * (it's the legacy `owl/owl.db`); a hex id must have its db on disk.
 *
 * @throws InvalidProfileIdError  if `profileId` isn't `local` or 32-hex
 * @throws ProfileDbMissingError  if a hex profile's db is absent
 */
export function setActiveProfile(profileId: string, path?: string): void {
  if (!isValidProfileId(profileId)) throw new InvalidProfileIdError(profileId);
  if (profileId !== LOCAL_PROFILE && !existsSync(profileDbPath(profileId))) {
    throw new ProfileDbMissingError(profileId);
  }
  const filePath = path ?? skybridgeConfigPath();
  mutateConfigFile(filePath, (raw) => {
    raw.active_profile = profileId;
  });
}

/**
 * Delete a `[profiles.<id>]` section. If it was the active profile,
 * `active_profile` falls back to `local`.
 */
export function removeProfile(profileId: string, path?: string): void {
  const filePath = path ?? skybridgeConfigPath();
  mutateConfigFile(filePath, (raw) => {
    // smol-toml drops undefined-valued keys on stringify, so clearing the
    // entry is equivalent to removing it (matches the codebase idiom).
    const profiles = raw.profiles as Record<string, unknown> | undefined;
    if (profiles && profileId in profiles) profiles[profileId] = undefined;
    if (raw.active_profile === profileId) raw.active_profile = LOCAL_PROFILE;
  });
}

/**
 * Drop the auth credentials after a 401 so the next sync round surfaces
 * `SKYBRIDGE_AUTH_REQUIRED` instead of replaying a dead token.
 *
 * Phase 13 — raw read-modify-write: when there's a valid active v2 profile,
 * clear only that section's auth fields (keeping device/workspace/server_id
 * and every sibling profile); otherwise drop the legacy top-level `[auth]`.
 * Never round-trips through `writeSkybridgeConfig`, which would flatten
 * `[profiles.*]` away.
 */
export function clearSkybridgeAuth(path?: string): void {
  const filePath = path ?? skybridgeConfigPath();
  if (!existsSync(filePath)) return;
  const active = resolveActiveProfile(filePath);
  // smol-toml drops undefined-valued keys on stringify, so nulling a field is
  // equivalent to removing it — same idiom the legacy clearSkybridgeAuth used.
  mutateConfigFile(filePath, (raw) => {
    if (active) {
      const section = (raw.profiles as Record<string, Record<string, unknown>> | undefined)?.[
        active.id
      ];
      if (section) {
        section.encrypted_token = undefined;
        section.token = undefined;
        section.user_id = undefined;
        section.email = undefined;
      }
    } else {
      raw.auth = undefined;
    }
  });
}

/** Delete the file entirely. Used by integration tests, not production. */
export function removeSkybridgeConfig(path?: string): void {
  const filePath = path ?? skybridgeConfigPath();
  if (existsSync(filePath)) unlinkSync(filePath);
}
