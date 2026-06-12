// `SyncStatusResult` is an HTTP wire type — it now lives in
// @orpheus-aviary/owl-shared (the neutral contract both renderer and mobile
// consume). Re-exported here so main's `sync-ipc.ts` import path stays stable.
import type { SyncStatusResult } from '@orpheus-aviary/owl-shared';
export type { SyncStatusResult };

/**
 * Discriminated union returned by every sync:* IPC handler. `ok: true`
 * carries the typed payload; `ok: false` carries a user-ready Chinese
 * message (mapped via `syncErrorMessage()` in main).
 *
 * Success shape for `void` operations is locked to
 * `{ ok: true, data: undefined }` so tests using exact-match don't
 * waver between `{ ok: true }` and `{ ok: true, data: undefined }`.
 */
export type SyncIpcReply<T> = { ok: true; data: T } | { ok: false; message: string };

/**
 * Identity + snapshot view used by Settings → 同步 tab. Single display
 * source of truth — renderer never reads `SyncSessionSummary` from
 * `loginAndOpenSession` directly; on login success it calls
 * `sync:status` again to refresh this shape.
 */
export interface SyncStatusReply {
  /**
   * Non-null only when ALL of:
   *  - toml carries a non-empty `auth.encrypted_token` (legacy plaintext
   *    `auth.token` is refused — encrypted-only restore is the contract
   *    in `restoreSessionOnStartup`)
   *  - `safeStorage.isEncryptionAvailable()` returns true
   *  - test-decrypt of `encrypted_token` succeeds (catches keychain
   *    migration / cross-OS corruption — same gate as
   *    `restoreSessionOnStartup` at `sync-auth.ts:225, 229`)
   *  - identity fields (`auth.user_id` / `auth.email` / `device.id` /
   *    `device.name` / `workspace.id`) are all present.
   *
   * Keeping this gate aligned with restore prevents the
   * "Settings shows 已登录 but next cold start fails restore" mismatch.
   */
  session: {
    email: string;
    server_url: string;
    workspace_id: string;
    workspace_slug: string | null;
    device_id: string;
    device_name: string;
  } | null;
  /** Null when daemon `/sync/status` is unreachable. */
  snapshot: SyncStatusResult | null;
}
