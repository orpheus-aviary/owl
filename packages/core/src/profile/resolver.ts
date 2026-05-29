/**
 * P5-d Phase 12 — active-profile db path resolver (blocker B6).
 *
 * Single chokepoint for "which owl.db does this process open". Daemon boot,
 * GUI startup precheck, and CLI direct mode all route through
 * `resolveActiveProfileDbPath()` so no entrypoint can bypass profile
 * isolation back onto the legacy global db (design §5.0).
 *
 * Phase 12 is behavior-preserving: the toml has no `active_profile` and the
 * `profiles/` layout doesn't exist yet, so this always falls back to the
 * legacy `paths.dbPath()`. Phase 13 introduces the layout + migration and
 * the resolver starts returning per-profile paths.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { dbPath, localProfileDbPath, profileDbPath, skybridgeConfigPath } from '../config/paths.js';

const LOCAL_PROFILE = 'local';
const PROFILE_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Read the top-level `active_profile` from skybridge_config.toml via a raw
 * parse — deliberately NOT `readSkybridgeConfig`, which throws when
 * `[server].url` is absent; reading `active_profile` needs no server url.
 * Any failure (missing file / parse error / absent or non-string field)
 * returns null. Never throws.
 */
export function readActiveProfileId(): string | null {
  const path = skybridgeConfigPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = parse(readFileSync(path, 'utf-8')) as { active_profile?: unknown };
    const id = parsed.active_profile;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** A profile id is either the reserved `local` or 32 lowercase hex chars. */
export function isValidProfileId(id: string): boolean {
  return id === LOCAL_PROFILE || PROFILE_ID_RE.test(id);
}

/**
 * Resolve the db path for the currently active profile, falling back to the
 * legacy global db when there's no usable active profile. Falls back (never
 * throws, never creates an empty db) on:
 *  - no `active_profile`
 *  - invalid id (path-escape / stale value guard)
 *  - target profile db doesn't exist yet (pre-migration)
 */
export function resolveActiveProfileDbPath(): string {
  const id = readActiveProfileId();
  if (id === null) return dbPath();
  if (!isValidProfileId(id)) return dbPath();
  const candidate = id === LOCAL_PROFILE ? localProfileDbPath() : profileDbPath(id);
  return existsSync(candidate) ? candidate : dbPath();
}
