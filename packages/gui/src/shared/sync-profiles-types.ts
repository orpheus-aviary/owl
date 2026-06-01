/**
 * P5-d Phase 17 (W4) — the saved-profile list behind `owlAPI.sync.profiles()`,
 * feeding the sidebar SyncStatusBar quick-switch list.
 *
 * `profiles` includes a synthetic `local` entry (id `'local'`) alongside every
 * `[profiles.<id>]` account. A profile is quick-switchable only when it has a
 * stored refresh token AND its db is on disk AND it isn't already active —
 * `db_missing` (a ghost section whose db is gone) must NOT be switched from the
 * popover, or `/sync/switch` would mkdir + revive it into an empty db.
 */
export interface ProfileSummary {
  /** `'local'` or a 32-hex profile id. */
  id: string;
  email: string | null;
  server_url: string | null;
  is_active: boolean;
  can_quick_switch: boolean;
  /** Account section present in toml but its profile db is missing (ghost). */
  db_missing: boolean;
}

export interface SyncProfilesReply {
  /** Effective active profile id (`'local'` or a profileId). */
  active: string;
  profiles: ProfileSummary[];
}
