// Database
export { createDatabase, schema, updateFtsTagsText } from './db/index.js';
export type { OwlDatabase, DatabaseOptions } from './db/index.js';
export { SPECIAL_NOTES, ensureSpecialNotes, ensureDeviceId } from './db/special-notes.js';

// Config
export { loadConfig, saveConfig, resolveLlmConfig, DEFAULT_CONFIG } from './config/index.js';
export type { OwlConfig, LlmConfig, DaemonConfig, LogConfig } from './config/index.js';
export * as paths from './config/paths.js';

// Logger
export { createLogger, createConsoleLogger } from './logger/index.js';
export type { Logger, LoggerOptions } from './logger/index.js';
