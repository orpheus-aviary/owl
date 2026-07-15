// Shared daemon ↔ client protocol constants (mobile-safe: no node/electron).

/**
 * Phase A (A6) — the local-mode auth protocol version a daemon enforces.
 *
 * A local daemon advertises `local_auth_version` on `GET /status`; GUI main
 * checks it before reusing an already-running daemon, so a stale pre-A6 daemon
 * (which lacks the field, or advertises a lower version) can be detected instead
 * of silently leaving the CSRF hole open. Bump only in a way that stays
 * backward-compatible with clients speaking v1 (`Authorization: Bearer`), or the
 * consumer check must tighten from `>=` to exact.
 */
export const LOCAL_AUTH_VERSION = 1;
