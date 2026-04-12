import type { Logger, OwlConfig, OwlDatabase } from '@owl/core';
import type Database from 'better-sqlite3';
import type { ReminderScheduler } from './scheduler.js';

/** Shared application context passed to all route handlers. */
export interface AppContext {
  db: OwlDatabase;
  sqlite: Database.Database;
  config: OwlConfig;
  /** Optional override for where to persist config writes (used by tests). */
  configPath?: string;
  logger: Logger;
  deviceId: string;
  scheduler: ReminderScheduler;
}
