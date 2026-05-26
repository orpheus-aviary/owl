/**
 * P5-d Phase 7 — single source of truth for the owl app version string
 * embedded into skybridge `registerDevice` payloads.
 *
 * Previously duplicated in `packages/daemon/src/sync/session.ts` and
 * `packages/gui/src/main/sync-auth.ts`. Both call sites format the value
 * as `owl ${OWL_APP_VERSION}` for the skybridge device record. Phase 14
 * release-bump checklist: change THIS file (0.5.0-dev → 0.5.0) and
 * everything downstream picks up the new tag automatically.
 *
 * Not the same thing as the gui `package.json` "version", which drives
 * the dmg / electron-builder release. That bumps separately per the
 * release process (see PROCESS.md).
 */
export const OWL_APP_VERSION = '0.5.0-dev';
