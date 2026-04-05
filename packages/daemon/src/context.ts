import type { Logger, OwlConfig, OwlDatabase } from '@owl/core';
import type Database from 'better-sqlite3';

/** Shared application context passed to all route handlers. */
export interface AppContext {
  db: OwlDatabase;
  sqlite: Database.Database;
  config: OwlConfig;
  logger: Logger;
  deviceId: string;
}
