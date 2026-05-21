/**
 * P5-a Step 6 — skybridge client config persistence.
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
 *  - Writes are full-file rewrites + `chmod 600`; we don't patch in-place
 *  - `sync_cursor` lives in sqlite, not here, so `owl sync reset` doesn't
 *    need to touch this file
 *
 * Token storage is plaintext for P5-a; keychain integration is P5-c.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { skybridgeConfigPath } from '../config/paths.js';

// ─── Types ──────────────────────────────────────────────

export interface SkybridgeServerSection {
  url: string;
}

export interface SkybridgeAuthSection {
  user_id: string;
  token: string;
  /** Only used by `owl sync config show`; never sent on the wire. */
  email: string;
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

// ─── Path helper ────────────────────────────────────────

export { skybridgeConfigPath };

// ─── Read ───────────────────────────────────────────────

/**
 * Load the client config from disk. Returns the parsed shape with
 * optional sections; the caller decides which conditions are fatal
 * (e.g. `requireAuth` narrows `auth` and throws if missing).
 *
 * Throws:
 *  - `SkybridgeNotConfiguredError` if the file does not exist
 *  - `SkybridgeServerUrlMissingError` if `[server].url` is missing
 */
export function readSkybridgeConfig(path?: string): SkybridgeConfig {
  const filePath = path ?? skybridgeConfigPath();
  if (!existsSync(filePath)) {
    throw new SkybridgeNotConfiguredError(filePath);
  }
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parse(raw) as Partial<SkybridgeConfig>;
  const url = parsed.server?.url;
  if (typeof url !== 'string' || url.length === 0) {
    throw new SkybridgeServerUrlMissingError(filePath);
  }
  const config: SkybridgeConfig = { server: { url } };
  if (parsed.auth?.user_id && parsed.auth?.token && parsed.auth?.email) {
    config.auth = {
      user_id: parsed.auth.user_id,
      token: parsed.auth.token,
      email: parsed.auth.email,
    };
  }
  if (parsed.device?.id) {
    config.device = {
      id: parsed.device.id,
      name: parsed.device.name ?? '',
      app_version: parsed.device.app_version ?? '',
      client_version: parsed.device.client_version ?? '',
    };
  }
  if (parsed.workspace?.id) {
    config.workspace = {
      id: parsed.workspace.id,
      slug: parsed.workspace.slug ?? '',
    };
  }
  return config;
}

/**
 * Narrow `SkybridgeConfig` to one whose `auth` is present.
 *
 * Daemon calls this right before issuing any authenticated client call.
 * 401 responses should call `clearSkybridgeAuth` so the next sync round
 * tells the user to re-login instead of looping with a dead token.
 */
export function requireAuth(
  config: SkybridgeConfig,
): SkybridgeConfig & { auth: SkybridgeAuthSection } {
  if (!config.auth) throw new SkybridgeAuthRequiredError();
  return config as SkybridgeConfig & { auth: SkybridgeAuthSection };
}

// ─── Write ──────────────────────────────────────────────

/**
 * Atomically replace the on-disk config and `chmod 600` it. The token
 * may be plaintext, so we restrict permissions; on Windows the chmod is
 * a no-op (Node coerces it silently).
 *
 * Always full-file rewrites — we never patch a single section in place,
 * which keeps concurrent writes well-defined (the last writer wins
 * instead of producing a mid-edit file).
 */
export function writeSkybridgeConfig(config: SkybridgeConfig, path?: string): void {
  const filePath = path ?? skybridgeConfigPath();
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // smol-toml drops `undefined`-valued keys; the optional sections show up
  // only when defined on the input object — exactly the round-trip shape
  // we want.
  const serialisable: Record<string, unknown> = { server: config.server };
  if (config.auth) serialisable.auth = config.auth;
  if (config.device) serialisable.device = config.device;
  if (config.workspace) serialisable.workspace = config.workspace;

  writeFileSync(filePath, stringify(serialisable), 'utf-8');
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Permissions are best-effort; FS without unix bits (e.g. Windows)
    // silently rejects. We deliberately don't fail the write for that.
  }
}

/**
 * Drop the `[auth]` section. Called after the server returns 401 so the
 * next sync round surfaces `SKYBRIDGE_AUTH_REQUIRED` instead of replaying
 * a dead token. Other sections (server / device / workspace) stay so
 * `owl sync login` can reuse the same server URL.
 */
export function clearSkybridgeAuth(path?: string): void {
  const filePath = path ?? skybridgeConfigPath();
  if (!existsSync(filePath)) return;
  const config = readSkybridgeConfig(filePath);
  config.auth = undefined;
  writeSkybridgeConfig(config, filePath);
}

/** Delete the file entirely. Used by integration tests, not production. */
export function removeSkybridgeConfig(path?: string): void {
  const filePath = path ?? skybridgeConfigPath();
  if (existsSync(filePath)) unlinkSync(filePath);
}
