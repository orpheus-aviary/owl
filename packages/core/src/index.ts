// Database
export { createDatabase, schema, updateFtsTagsText } from './db/index.js';
export type { OwlDatabase, DatabaseOptions } from './db/index.js';
export { SPECIAL_NOTES, ensureSpecialNotes, ensureDeviceId } from './db/special-notes.js';

// Config
export { loadConfig, saveConfig, resolveLlmConfig, DEFAULT_CONFIG } from './config/index.js';
export type {
  OwlConfig,
  LlmConfig,
  LlmApiFormat,
  DaemonConfig,
  LogConfig,
  EditorConfig,
  BrowserConfig,
} from './config/index.js';
export * as paths from './config/paths.js';

// Logger
export { createLogger, createConsoleLogger } from './logger/index.js';
export type { Logger, LoggerOptions } from './logger/index.js';

// Notes
export {
  createNote,
  getNote,
  listNotes,
  listAlarmNotes,
  updateNote,
  deleteNote,
  restoreNote,
  permanentDeleteNote,
  batchDeleteNotes,
  batchRestoreNotes,
  batchPermanentDeleteNotes,
  contentHash,
} from './notes/index.js';
export type {
  NoteWithTags,
  CreateNoteInput,
  UpdateNoteInput,
  ListNotesOptions,
} from './notes/index.js';

// Tags
export {
  parseTag,
  parseTags,
  inferDateTime,
  TAG_TYPES,
} from './tags/parser.js';
export type { ParsedTag, TagType } from './tags/parser.js';

// Search
export { searchNotes, searchNotesWithDetails } from './search/index.js';
export type { SearchResult } from './search/index.js';

// Reminders
export {
  syncReminders,
  getPendingReminders,
  getOverdueReminders,
  getNextPendingReminder,
  markFired,
  getNoteTitle,
  normalizeFireAt,
  cleanupExpiredTrash,
} from './reminders/index.js';
export type { ReminderRecord } from './reminders/index.js';
