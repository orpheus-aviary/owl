// Wire types shared by every owl front-end (Electron renderer, web, mobile).
// snake_case fields mirror the daemon's HTTP/SSE payloads verbatim; interface
// names are PascalCase. These are the data contract — kept free of any
// Electron / Node / DOM-host concept so the same definitions compile for web
// and React Native.

// Config types (OwlConfig + sections + cloud projections) are the `/config`
// wire contract; they live in ./config-types (canonical, shared with @owl/core)
// and are re-exported here so `@orpheus-aviary/owl-shared` keeps one surface.
export type * from './config-types.js';

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
  /**
   * 0011 (0.6.2 W1) — the other two dimensions of the LWW key
   * `(updated_at_ms, lww_counter, device_id)`. All nullable: rows detected
   * before 0.6.2 have none of them, and a NULL device_id means「未知设备」
   * (core normalizes the `''` placeholder back to NULL on write).
   */
  local_lww_counter: number | null;
  remote_lww_counter: number | null;
  local_device_id: string | null;
  remote_device_id: string | null;
}
