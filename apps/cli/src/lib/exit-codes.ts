/**
 * Exit code taxonomy for `owl` CLI. Stable contract documented in the
 * P3.2-c design (§3.4). Values are chosen to avoid clashes with common
 * shell conventions (0 success, 1 generic failure, 2 misuse, …) while
 * giving agents enough resolution to branch on.
 */
export const EXIT_CODES = {
  /** Success, including doctor reporting `warn`. */
  OK: 0,
  /** Ordinary failure (NOTE_NOT_FOUND, DB_BUSY, HTTP_ERROR, UNKNOWN). */
  FAILURE: 1,
  /** Argument / usage error (USAGE_ERROR, INVALID_JSON_INPUT, INVALID_TAG). */
  USAGE: 2,
  /** Environment / configuration problem (CONFIG_NOT_FOUND, doctor fail). */
  ENV: 3,
  /** Daemon unavailable when explicitly required (HTTP mode only). */
  DAEMON_UNAVAILABLE: 4,
  /** Conflict (VERSION_MISMATCH, DAEMON_RUNNING_BLOCKED, MIGRATION_BUSY, …). */
  CONFLICT: 5,
  /** User cancelled (SIGINT, migrate y/N → N). */
  CANCELLED: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
