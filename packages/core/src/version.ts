/**
 * P5-d Phase 7 — single source of truth for the owl app version string
 * embedded into skybridge `registerDevice` payloads.
 *
 * Previously duplicated in `packages/daemon/src/sync/session.ts` and
 * `packages/gui/src/main/sync-auth.ts`. Both call sites format the value
 * as `owl ${OWL_APP_VERSION}` for the skybridge device record. Bump it with
 * each release and everything downstream picks up the new tag automatically —
 * 0.6.0 shipped without doing so, which left every device registered since
 * then labelled `owl 0.5.0` in 设备管理.
 *
 * Not the same thing as the gui `package.json` "version", which drives
 * the dmg / electron-builder release. That bumps separately per the
 * release process (see PROCESS.md).
 */
export const OWL_APP_VERSION = '0.6.1';
