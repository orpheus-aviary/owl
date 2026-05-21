import { EXIT_CODES, type ExitCode } from './exit-codes.js';

/**
 * Closed set of CLI-visible error codes. Mirrors the design doc §3.5
 * table. Daemon wire codes come in via `mapHttpError` (see §3.3) and
 * land on one of these values before reaching the user.
 */
export const ERROR_CODES = {
  USAGE_ERROR: 'USAGE_ERROR',
  INVALID_JSON_INPUT: 'INVALID_JSON_INPUT',
  INVALID_TAG: 'INVALID_TAG',
  CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
  DATA_DIR_MISSING: 'DATA_DIR_MISSING',
  ENV_UNSUPPORTED: 'ENV_UNSUPPORTED',
  DAEMON_UNAVAILABLE: 'DAEMON_UNAVAILABLE',
  DAEMON_RUNNING_BLOCKED: 'DAEMON_RUNNING_BLOCKED',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  MIGRATION_REQUIRED: 'MIGRATION_REQUIRED',
  INCOMPATIBLE_DB: 'INCOMPATIBLE_DB',
  MIGRATION_BUSY: 'MIGRATION_BUSY',
  NOTE_NOT_FOUND: 'NOTE_NOT_FOUND',
  ALREADY_TRASHED: 'ALREADY_TRASHED',
  DB_BUSY: 'DB_BUSY',
  HTTP_ERROR: 'HTTP_ERROR',
  USER_CANCELLED: 'USER_CANCELLED',
  // P5-a Step 8 — skybridge sync codes. Daemon's `error_code` field
  // already uses these literals, so `mapHttpError` recognises them
  // directly with no extra translation.
  SKYBRIDGE_NOT_CONFIGURED: 'SKYBRIDGE_NOT_CONFIGURED',
  SKYBRIDGE_SERVER_URL_MISSING: 'SKYBRIDGE_SERVER_URL_MISSING',
  SKYBRIDGE_AUTH_REQUIRED: 'SKYBRIDGE_AUTH_REQUIRED',
  SKYBRIDGE_NOT_INSTALLED: 'SKYBRIDGE_NOT_INSTALLED',
  SKYBRIDGE_SERVER_UNREACHABLE: 'SKYBRIDGE_SERVER_UNREACHABLE',
  SKYBRIDGE_API_ERROR: 'SKYBRIDGE_API_ERROR',
  SKYBRIDGE_SYNC_FAILED: 'SKYBRIDGE_SYNC_FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const EXIT_MAP: Record<ErrorCode, ExitCode> = {
  USAGE_ERROR: EXIT_CODES.USAGE,
  INVALID_JSON_INPUT: EXIT_CODES.USAGE,
  INVALID_TAG: EXIT_CODES.USAGE,
  CONFIG_NOT_FOUND: EXIT_CODES.ENV,
  DATA_DIR_MISSING: EXIT_CODES.ENV,
  ENV_UNSUPPORTED: EXIT_CODES.ENV,
  DAEMON_UNAVAILABLE: EXIT_CODES.DAEMON_UNAVAILABLE,
  DAEMON_RUNNING_BLOCKED: EXIT_CODES.CONFLICT,
  VERSION_MISMATCH: EXIT_CODES.CONFLICT,
  MIGRATION_REQUIRED: EXIT_CODES.CONFLICT,
  INCOMPATIBLE_DB: EXIT_CODES.CONFLICT,
  MIGRATION_BUSY: EXIT_CODES.CONFLICT,
  NOTE_NOT_FOUND: EXIT_CODES.FAILURE,
  ALREADY_TRASHED: EXIT_CODES.FAILURE,
  DB_BUSY: EXIT_CODES.FAILURE,
  HTTP_ERROR: EXIT_CODES.FAILURE,
  // Skybridge config-shape failures point the user at a fix-the-env
  // action (login / install); wire-level failures map to FAILURE.
  SKYBRIDGE_NOT_CONFIGURED: EXIT_CODES.ENV,
  SKYBRIDGE_SERVER_URL_MISSING: EXIT_CODES.ENV,
  SKYBRIDGE_AUTH_REQUIRED: EXIT_CODES.ENV,
  SKYBRIDGE_NOT_INSTALLED: EXIT_CODES.ENV,
  SKYBRIDGE_SERVER_UNREACHABLE: EXIT_CODES.FAILURE,
  SKYBRIDGE_API_ERROR: EXIT_CODES.FAILURE,
  SKYBRIDGE_SYNC_FAILED: EXIT_CODES.FAILURE,
  UNKNOWN: EXIT_CODES.FAILURE,
  USER_CANCELLED: EXIT_CODES.CANCELLED,
};

export function exitCodeFor(code: ErrorCode): ExitCode {
  return EXIT_MAP[code] ?? EXIT_CODES.FAILURE;
}

/** Shape of daemon failure payload (see §3.3). */
export interface DaemonFailBody {
  success: false;
  message?: string;
  error_code?: string;
  details?: Record<string, unknown>;
}

/**
 * Translate a daemon HTTP error body into a `CliError`. Unknown codes
 * fall back to `HTTP_ERROR` so the CLI stays predictable even when the
 * daemon introduces a new code before we update the CLI.
 */
export function mapHttpError(status: number, body: DaemonFailBody | undefined): CliError {
  const code = body?.error_code;
  const message = body?.message ?? `HTTP ${status}`;
  const details = body?.details;

  if (code && (code as ErrorCode) in EXIT_MAP) {
    return new CliError(code as ErrorCode, message, details);
  }
  // Daemon returned a shape we don't recognize — keep the text, bucket as HTTP_ERROR.
  return new CliError('HTTP_ERROR', message, {
    status,
    ...(code !== undefined ? { daemon_code: code } : {}),
    ...(details ?? {}),
  });
}
