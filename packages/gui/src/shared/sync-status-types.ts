/**
 * Wire shape returned by `GET /sync/status`. Daemon source of truth is
 * `SyncStatusResult` in `packages/daemon/src/sync/manual.ts:273`. This
 * mirror lives in `shared/` so both renderer (`lib/api.ts`) and main
 * (`sync-ipc.ts`) reference the same type — main can't borrow from
 * renderer's `lib/`, and renderer can't borrow from main.
 *
 * Reflects configured-ness + cursor truth from sqlite; does NOT carry
 * the live `state` / `last_error` overlay (those are broadcaster-only
 * and only show up on SSE).
 */
export interface SyncStatusResult {
  configured: boolean;
  authenticated: boolean;
  server_url: string | null;
  device_id: string | null;
  workspace_id: string | null;
  pending_count: number;
  pulled_seq: number;
  pushed_seq: number;
  last_sync_at: number | null;
}

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
