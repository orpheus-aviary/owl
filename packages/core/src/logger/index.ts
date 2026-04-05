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
    transport: {
      target: 'pino/file',
      options: { destination: 1 }, // stdout
    },
  });
}
