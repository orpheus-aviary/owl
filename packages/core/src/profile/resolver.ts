/**
 * P5-d Phase 12/13 — active-profile resolution (blocker B6).
 *
 * Single chokepoint for two coupled decisions:
 *   - which `owl.db` does this process open  (`resolveActiveProfileDbPath`)
 *   - which config section does the adapter read (`readSkybridgeConfig`, via
 *     `resolveActiveProfile`)
 *
 * Both route through the one `resolveActiveProfile()` three-way gate so the
 * two can never disagree (design §5.0 + Phase 13 §1.1). Daemon boot, GUI
 * startup precheck, and CLI direct mode all call `resolveActiveProfileDbPath`,
 * so no entrypoint can bypass profile isolation back onto the legacy db.
 *
 * Phase 13 stays behavior-preserving: no live path writes
 * `profiles/<id>/owl.db` yet (login flip is Phase 15), so the gate always
 * fails and the resolver keeps returning the legacy `paths.dbPath()`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { dbPath, profileDbPath, skybridgeConfigPath } from '../config/paths.js';

/** The reserved id for the never-logged-in / offline local workspace. */
export const LOCAL_PROFILE = 'local';
const PROFILE_ID_RE = /^[0-9a-f]{32}$/;

export interface ActiveProfile {
  /** Always a 32-hex profile id — never the reserved `local`. */
  readonly id: string;
  /** `profiles/<id>/owl.db` (nest-relative). */
  readonly dbPath: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Raw-parse skybridge_config.toml. Returns null on missing file / parse
 * error / non-object root. Never throws — deliberately NOT
 * `readSkybridgeConfig`, which throws when `[server].url` is absent.
 */
function parseSkybridgeTomlSafe(path?: string): Record<string, unknown> | null {
  const filePath = path ?? skybridgeConfigPath();
  if (!existsSync(filePath)) return null;
  try {
    const parsed = parse(readFileSync(filePath, 'utf-8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Low-level: the top-level `active_profile` string, or null. No validation
 * beyond "non-empty string"; callers that need the full gate use
 * `resolveActiveProfile`.
 */
export function readActiveProfileId(path?: string): string | null {
  const id = parseSkybridgeTomlSafe(path)?.active_profile;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** A profile id is either the reserved `local` or 32 lowercase hex chars. */
export function isValidProfileId(id: string): boolean {
  return id === LOCAL_PROFILE || PROFILE_ID_RE.test(id);
}

/** True only for a real (hex) profile id — rejects `local` and anything else. */
export function isHexProfileId(id: string): boolean {
  return PROFILE_ID_RE.test(id);
}

/**
 * The single active-profile decision — a **three-way-consistent gate**,
 * judged exactly once here:
 *   ① `active_profile` is a valid hex id (not `local` / not malformed)
 *   ② the `[profiles.<id>]` section exists in the toml
 *   ③ the profile db file exists on disk
 * Missing any one → null = use local/legacy (`owl/owl.db` + top-level
 * `[auth]` view).
 *
 * The resolver (which db to open) and `readSkybridgeConfig` (which config
 * section to read) share this, so **both** split-brain directions are sealed:
 *   - db present but section absent → null → both fall to legacy
 *     (never "profile db + legacy config")
 *   - section present but db absent → null → both fall to legacy
 *     (never "account session + local db")
 *
 * `path` is threaded into the toml read so callers stay pinned to the same
 * file as `readSkybridgeConfig(path?)` (Phase 13 §1.1/P2). The db existence
 * check uses the nest-relative `profileDbPath(id)`.
 */
export function resolveActiveProfile(path?: string): ActiveProfile | null {
  const parsed = parseSkybridgeTomlSafe(path);
  if (parsed === null) return null;
  const id = parsed.active_profile;
  if (typeof id !== 'string' || !isHexProfileId(id)) return null; // ① (rejects 'local')
  const profiles = parsed.profiles;
  if (!isPlainObject(profiles) || !isPlainObject(profiles[id])) return null; // ②
  const p = profileDbPath(id);
  return existsSync(p) ? { id, dbPath: p } : null; // ③
}

/**
 * Resolve the db path for the active profile, falling back to the legacy
 * global db (`owl/owl.db`) whenever there's no usable active profile. Never
 * throws, never creates an empty db.
 *
 * Behavior-preserving in Phase 13: the gate always fails (no live profile db
 * exists yet), so this keeps returning `dbPath()`.
 */
export function resolveActiveProfileDbPath(path?: string): string {
  return resolveActiveProfile(path)?.dbPath ?? dbPath();
}

/**
 * P5-d Phase 17 (W4) — the **effective** active profile id: the same three-way
 * gate as `resolveActiveProfile`, collapsed to `local` whenever the gate fails.
 *
 * Quick-switch / profile-list / delete decisions must use this rather than the
 * raw `readActiveProfileId()`: a `[profiles.<id>]` section whose db is missing
 * (a "ghost") is what the resolver already treats as local. Reading the raw
 * `active_profile` could mark such a ghost as current, make a switch into it a
 * no-op, or roll back onto a profile that doesn't really resolve.
 */
export function readEffectiveActiveProfileId(path?: string): string {
  return resolveActiveProfile(path)?.id ?? LOCAL_PROFILE;
}
