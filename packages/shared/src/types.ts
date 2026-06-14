// Wire types shared by every owl front-end (Electron renderer, web, mobile).
// snake_case fields mirror the daemon's HTTP/SSE payloads verbatim; interface
// names are PascalCase. These are the data contract — kept free of any
// Electron / Node / DOM-host concept so the same definitions compile for web
// and React Native.

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error_code?: string;
  total?: number;
}

export interface NoteTag {
  id: string;
  tagType: string;
  tagValue: string | null;
}

export interface Note {
  id: string;
  content: string;
  folderId: string | null;
  trashLevel: number;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
  /** Sticky auto-delete deadline for trash_level=2 notes (ISO string). */
  autoDeleteAt: string | null;
  deviceId: string | null;
  contentHash: string | null;
  /** ISO string when pinned (P3.4-a). null = not pinned. */
  pinnedAt: string | null;
  /** Per-folder manual sort key (P3.4-a). null until the user reorders. */
  position: number | null;
  tags: NoteTag[];
}

export interface Tag {
  id: string;
  tagType: string;
  tagValue: string;
}

export interface FrequentTag extends Tag {
  usage_count: number;
}

export interface ParsedTag {
  tagType: string;
  tagValue: string;
}

export interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
  device_id: string | null;
}

export interface FolderReorderItem {
  id: string;
  parent_id: string | null;
  position: number;
}

export interface TodoItem {
  line: number;
  text: string;
  checked: boolean;
}

export interface TodoGroup {
  note_id: string;
  note_title: string;
  created_at: string;
  items: TodoItem[];
}

export interface ShortcutsConfig {
  save: string;
  close_tab: string;
  toggle_wrap: string;
  toggle_edit_mode: string;
  new_note: string;
  nav_editor: string;
  nav_browser: string;
  nav_trash: string;
  nav_reminders: string;
  nav_todo: string;
  nav_ai: string;
  nav_settings: string;
  toggle_folder_panel: string;
  /** OS-level invoke shortcut handled by main process Electron globalShortcut. */
  global_invoke: string;
}

export type LlmApiFormat = 'openai' | 'anthropic';

export interface LlmConfig {
  url: string;
  model: string;
  api_key: string;
  api_format: LlmApiFormat;
  /** Round-trip the model's reasoning/thinking back. See core config docs. */
  thinking_round_trip: boolean;
}

export interface EditorConfig {
  default_mode: 'edit' | 'split' | 'preview';
}

export interface BrowserConfig {
  default_sort_field: 'updated' | 'created';
  default_sort_direction: 'asc' | 'desc';
}

// Contract (Phase A): on a local daemon `GET/PATCH /config` returns the full
// `OwlConfig` including `llm.api_key`. On a cloud daemon, GET returns the full
// config to the owner session but a `PublicOwlConfig` projection (secret
// stripped, `has_api_key` flagged) to a non-owner; PATCH of `llm.*` is
// owner-only. Web consumers should type the GET response as
// `OwlConfig | PublicOwlConfig` and never assume `llm.api_key` is present.
// See the ecosystem arch §9 + Phase A design §6.
export interface OwlConfig {
  llm: LlmConfig;
  window: { width: number; height: number };
  font: { global_offset: number; editor_font_size: number; editor_line_height: number };
  navigation: { order: string[] };
  daemon: {
    poll_interval_min: number;
    port: number;
    // Phase A — mirrors core DaemonConfig. `mode`/`bind` always present;
    // the cloud-only fields are present only on a cloud daemon's config.
    mode: 'local' | 'cloud';
    bind: string;
    server_url?: string;
    account_lock?: string;
    public_url?: string;
    allowed_origins?: string[];
    allowed_hosts?: string[];
    session_ttl_min?: number;
    trust_proxy?: boolean;
  };
  ai: {
    context_rounds: number;
    max_recent_notes: number;
    max_context_chars: number;
  };
  trash: { auto_delete_days: number };
  log: {
    max_size_mb: number;
    max_backups: number;
    max_age_days: number;
    level: 'debug' | 'info' | 'warn' | 'error';
  };
  editor: EditorConfig;
  browser: BrowserConfig;
  shortcuts: ShortcutsConfig;
}

// Cloud non-owner projection of OwlConfig. Mirrors `@owl/core`'s redactConfig
// output: `llm` drops `api_key` and gains `has_api_key`; everything else is
// identical. The key itself is never sent over the wire to a non-owner.
export interface PublicLlmConfig {
  url: string;
  model: string;
  api_format: LlmApiFormat;
  thinking_round_trip: boolean;
  has_api_key: boolean;
}

export type PublicOwlConfig = Omit<OwlConfig, 'llm'> & { llm: PublicLlmConfig };

export interface AiToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiConversationSummary {
  id: string;
  /** P3.4-f: title derived from first user message (32-char truncated). */
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

/**
 * Hydration-shaped message from `GET /ai/conversations/:id`. Mirrors the
 * daemon's LlmMessage minus:
 *   - role='system' (filtered by daemon — prompt engineering is private)
 *   - reasoning_signature (Anthropic-only opaque blob, unused by GUI)
 * `reasoning_content` IS included so GUI can hydrate `ChatMessage.thinking`.
 * `is_error` on tool messages hydrates `ChatToolCall.isError`.
 */
export interface AiHistoryMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; name: string; arguments: string }[];
  tool_call_id?: string;
  is_error?: boolean;
  reasoning_content?: string;
}

export interface AiConversationDetail {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: AiHistoryMessage[];
}

export interface AiPreviewSummary {
  id: string;
  action: 'create' | 'update' | 'create_reminder';
  note_id?: string;
  content: string;
  tags: string[];
  folder_id: string | null;
  created_at: string;
  expires_at: string;
}

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline';

/**
 * Wire shape pushed on SSE `sync:status_changed`. Daemon source of truth
 * is `SyncStatusSnapshot` in `packages/daemon/src/events/types.ts`. The
 * GET endpoint does not return `state` / `last_error` (only the
 * broadcaster knows those), so the renderer derives an initial state of
 * 'idle' from a fresh GET and lets subsequent SSE events overwrite it.
 */
export interface SyncStatusSnapshot {
  state: SyncState;
  server_url: string | null;
  device_id: string | null;
  workspace_id: string | null;
  pending_count: number;
  pulled_seq: number;
  pushed_seq: number;
  last_sync_at: number | null;
  last_error: string | null;
}

/**
 * Wire shape returned by `GET /sync/status`. Daemon source of truth is
 * `SyncStatusResult` in `packages/daemon/src/sync/manual.ts`. Mirrored here
 * (not imported from the daemon) so front-end type-graphs never drag Node /
 * core modules in. Reflects configured-ness + cursor truth from sqlite; does
 * NOT carry the live `state` / `last_error` overlay (broadcaster-only, SSE).
 */
export interface SyncStatusResult {
  configured: boolean;
  authenticated: boolean;
  server_url: string | null;
  device_id: string | null;
  workspace_id: string | null;
  pending_count: number;
  pulled_seq: number;
  pushed_seq: number;
  last_sync_at: number | null;
}

/**
 * Wire shape of one row from `GET /conflicts`. snake_case mirrors what the
 * daemon emits straight from `conflict_record`. `local_payload` /
 * `remote_payload` are serialized JSON strings — callers JSON.parse on read.
 */
export interface ConflictRecord {
  id: string;
  entity_type: string;
  entity_id: string;
  local_seq: number | null;
  remote_seq: number | null;
  detected_at: number;
  resolved_at: number | null;
  resolution: string | null;
  losing_side: string | null;
  local_payload: string | null;
  remote_payload: string | null;
  local_updated_at_ms: number | null;
  remote_updated_at_ms: number | null;
}
