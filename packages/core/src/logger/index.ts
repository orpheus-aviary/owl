import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino from 'pino';
import type { LogConfig } from '../config/index.js';

export type Logger = pino.Logger;

export interface LoggerOptions {
  /** Log file path */
  filePath: string;
  /** Log config from owl_config.toml */
  config: LogConfig;
  /** Logger name (e.g. 'owl', 'daemon') */
  name: string;
}

/**
 * P5-c §6.27 — default `pino.redact` paths.
 *
 * Both `createLogger` (file-rolling) and `createConsoleLogger` (stdout)
 * apply these so any structured log line that carries a token field is
 * automatically masked to `[REDACTED]` before serialization. Raw string
 * interpolation of token values sidesteps `pino.redact` entirely —
 * that's the job of the CI grep守卫 in
 * `scripts/check-token-not-templated.sh`.
 *
 * The path globs cover:
 *   - `*.token`               — any object property named `token`
 *   - `*.auth.token`          — explicit nested cfg shape
 *   - `*.encrypted_token`     — P5-d Phase 7 ciphertext; not strictly
 *                                secret, but redacted defensively so
 *                                logs never tempt offline analysis
 *   - `*.auth.encrypted_token` — explicit nested cfg shape
 *   - `*.profiles.*.encrypted_token` — P5-d Phase 12: per-profile toml
 *                                shape `cfg.profiles.<id>.encrypted_token`
 *   - `*.profiles.*.auth.token` — per-profile legacy token under
 *                                `cfg.profiles.<id>.auth.token`
 *   - `*.encrypted_refresh_token` / `*.auth.encrypted_refresh_token` /
 *     `*.profiles.*.encrypted_refresh_token` — P5-d Phase 15: rotating
 *                                refresh-token ciphertext (D2)
 *   - `authorization`         — top-level header
 *   - `headers.authorization` — http req object shape
 *   - `req.headers.authorization` — fastify req shape
 */
export const DEFAULT_LOG_REDACT_PATHS: readonly string[] = [
  '*.token',
  '*.auth.token',
  '*.encrypted_token',
  '*.auth.encrypted_token',
  '*.profiles.*.encrypted_token',
  '*.profiles.*.auth.token',
  '*.encrypted_refresh_token',
  '*.auth.encrypted_refresh_token',
  '*.profiles.*.encrypted_refresh_token',
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
];

const DEFAULT_REDACT = {
  paths: [...DEFAULT_LOG_REDACT_PATHS],
  censor: '[REDACTED]',
};

/**
 * Create a pino logger with file rotation via pino-roll.
 */
export function createLogger(options: LoggerOptions): Logger {
  const { filePath, config, name } = options;

  // Ensure log directory exists
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const transport = pino.transport({
    target: 'pino-roll',
    options: {
      file: filePath,
      size: `${config.max_size_mb}m`,
      frequency: 'daily',
      limit: {
        count: config.max_backups,
      },
      mkdir: true,
    },
  });

  return pino(
    {
      name,
      level: config.level,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: DEFAULT_REDACT,
    },
    transport,
  );
}

/**
 * Create a simple stdout logger (for development / CLI).
 */
export function createConsoleLogger(name: string, level = 'info'): Logger {
  return pino({
    name,
    level,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: DEFAULT_REDACT,
    transport: {
      target: 'pino/file',
      options: { destination: 1 }, // stdout
    },
  });
}
