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
  ForwardMigrationError,
  DestructiveForwardMigrationError,
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
export {
  loadConfig,
  saveConfig,
  resolveLlmConfig,
  effectiveSyncIntervalMin,
  DEFAULT_CONFIG,
} from './config/index.js';
export type {
  OwlConfig,
  LlmConfig,
  LlmApiFormat,
  AiConfig,
  DaemonConfig,
  SyncConfig,
  LogConfig,
  EditorConfig,
  BrowserConfig,
} from './config/index.js';
export * as paths from './config/paths.js';

// Shortcuts (canonical → Electron accelerator conversion for main process)
export { toElectronAccelerator } from './shortcuts/accelerator.js';

// Logger
export {
  createLogger,
  createConsoleLogger,
  DEFAULT_LOG_REDACT_PATHS,
} from './logger/index.js';
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
  setNotePinned,
  reorderNotesInFolder,
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

// Sync (P4 Phase 2 — local change log)
export { emitSyncChange } from './sync/changes.js';
export type { SyncEntityType, SyncOp, EmitSyncChangeArgs } from './sync/changes.js';

// Sync apply-side payload validators (P5-a Step 4b — note ops only)
export * as syncPayloads from './sync/payloads/note.js';

// Sync engine (P5-a Step 5 — pull/push runner with structural client)
export { runSync, upsertSyncCursor, SkybridgeProtocolError } from './sync/engine.js';
export type {
  LocalChangeLike,
  ServerChangeLike,
  PushAckLike,
  PushResultLike,
  PullResultLike,
  SkybridgeClientLike,
  RunSyncDeps,
  RunSyncResult,
  RunSyncLogger,
} from './sync/engine.js';

// HTTP retry wrapper (P5-c §2.3)
export {
  withRetry,
  defaultIsRetryable,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BACKOFF_MS,
  DEFAULT_JITTER_MS,
} from './sync/retry.js';
export type { WithRetryOptions, RetryLogger } from './sync/retry.js';

// Conflict_record helpers (P5-c §2.4)
export {
  recordConflict,
  listUnresolvedConflicts,
  countUnresolvedConflicts,
  ignoreConflict,
} from './sync/conflicts.js';
export type {
  ConflictRecord,
  ConflictLosingSide,
  ConflictResolution,
  RecordConflictArgs,
} from './sync/conflicts.js';

// Skybridge client config (P5-a Step 6 — TOML read/write)
export {
  clearSkybridgeAuth,
  readSkybridgeConfig,
  removeSkybridgeConfig,
  requireAuth,
  skybridgeConfigPath,
  SkybridgeAuthRequiredError,
  SkybridgeNotConfiguredError,
  SkybridgeServerUrlMissingError,
  writeSkybridgeConfig,
} from './skybridge/config.js';
export type {
  SkybridgeAuthSection,
  SkybridgeConfig,
  SkybridgeDeviceSection,
  SkybridgeServerSection,
  SkybridgeWorkspaceSection,
} from './skybridge/config.js';
export { clearSyncIdentity, persistSkybridgeIds } from './skybridge/identity.js';
export { redactToken } from './skybridge/redact.js';
export type { RedactTokenOptions } from './skybridge/redact.js';
export { OWL_APP_VERSION } from './version.js';

// Conversations (AI chat persistence)
export {
  appendConversationMessages,
  deleteConversation,
  hydrateConversation,
  listConversationSummaries,
} from './conversations/index.js';
export type {
  ConversationMessageRow,
  ConversationSummary,
  HydratedConversation,
} from './conversations/index.js';

// Reminders
export {
  syncReminders,
  getPendingReminders,
  getOverdueReminders,
  getNextPendingReminder,
  markFired,
  rescheduleRecurringReminder,
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
