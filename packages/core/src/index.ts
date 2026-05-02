// Database
export { createDatabase, schema, updateFtsTagsText } from './db/index.js';
export type { OwlDatabase, DatabaseOptions } from './db/index.js';
export { SPECIAL_NOTES, ensureSpecialNotes, ensureDeviceId } from './db/special-notes.js';
export {
  LATEST_KNOWN_VERSION,
  migrateLegacyDb,
  MigrationRequiredError,
  IncompatibleDbError,
  MigrationBusyError,
  SourceDbCorruptionError,
  SchemaMismatchError,
} from './db/migrate.js';
export type {
  MigrateOptions,
  MigratePhase,
  MigrateResult,
  MigrationBusyReason,
} from './db/migrate.js';
export { probeStartupState } from './db/probe.js';
export type { StartupProbeResult } from './db/probe.js';

// Config
export { loadConfig, saveConfig, resolveLlmConfig, DEFAULT_CONFIG } from './config/index.js';
export type {
  OwlConfig,
  LlmConfig,
  LlmApiFormat,
  AiConfig,
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
  UpdateNoteOptions,
  DeleteNoteOptions,
  RestoreNoteOptions,
  ListNotesOptions,
} from './notes/index.js';
export { VersionMismatchError, AlreadyTrashedError } from './notes/errors.js';

// Folders
export {
  createFolder,
  getFolder,
  listFolders,
  updateFolder,
  deleteFolder,
  reorderFolders,
  getFolderSubtreeIds,
} from './folders/index.js';
export type {
  Folder,
  CreateFolderInput,
  UpdateFolderInput,
  ReorderFolderItem,
} from './folders/index.js';

// Tags
export {
  parseTag,
  parseTags,
  inferDateTime,
  TAG_TYPES,
} from './tags/parser.js';
export type { ParsedTag, TagType } from './tags/parser.js';
export { listHashtagTags } from './tags/list.js';
export type { ListHashtagTagsOptions, HashtagTagRow } from './tags/list.js';

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
  cleanupOldFiredReminders,
  recomputeTrashDeadlines,
  getNextTrashDeadline,
  listRemindersWithStatus,
} from './reminders/index.js';
export type {
  ReminderRecord,
  ReminderWithNote,
  ListRemindersOptions,
} from './reminders/index.js';
