// ─── Types ──────────────────────────────────────────────

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

// ─── API Client ─────────────────────────────────────────

/**
 * Resolve the daemon base URL. Exported so `sse-client` callers can
 * compose the `/ai/chat` URL without re-implementing this lookup.
 */
export function baseUrl(): string {
  return window.owlAPI?.daemonUrl ?? 'http://127.0.0.1:47010';
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public errorCode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  retries = 2,
): Promise<ApiResponse<T>> {
  const url = `${baseUrl()}${path}`;
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, init);
      const json = (await res.json()) as ApiResponse<T>;

      if (!json.success) {
        throw new ApiError(res.status, json.error_code, json.message ?? 'Unknown error');
      }
      return json;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (attempt === retries) throw err;
      // Wait before retry (daemon might be restarting)
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error('Unreachable');
}

// ─── Endpoints ──────────────────────────────────────────

// System
export const getStatus = () => request<{ status: string }>('GET', '/status');

// Notes
export function listNotes(params?: {
  q?: string;
  folder_id?: string;
  include_descendants?: boolean;
  trash_level?: number;
  tags?: string;
  sort_by?: 'updated' | 'created' | 'position';
  sort_order?: 'asc' | 'desc';
  pinned_first?: boolean;
  page?: number;
  limit?: number;
}) {
  const qs = new URLSearchParams();
  if (params?.q) qs.set('q', params.q);
  if (params?.folder_id) qs.set('folder_id', params.folder_id);
  if (params?.include_descendants !== undefined) {
    qs.set('include_descendants', String(params.include_descendants));
  }
  if (params?.trash_level !== undefined) qs.set('trash_level', String(params.trash_level));
  if (params?.tags) qs.set('tags', params.tags);
  if (params?.sort_by) qs.set('sort_by', params.sort_by);
  if (params?.sort_order) qs.set('sort_order', params.sort_order);
  if (params?.pinned_first) qs.set('pinned_first', 'true');
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return request<Note[]>('GET', `/notes${query ? `?${query}` : ''}`);
}

export const getNote = (id: string) => request<Note>('GET', `/notes/${id}`);

export const createNote = (data: { content: string; folder_id?: string; tags?: string[] }) =>
  request<Note>('POST', '/notes', data);

export const patchNote = (
  id: string,
  data: { content?: string; folder_id?: string | null; tags?: string[] },
) => request<Note>('PATCH', `/notes/${id}`, data);

export const deleteNote = (id: string) => request<Note>('DELETE', `/notes/${id}`);

export const restoreNote = (id: string) => request<Note>('POST', `/notes/${id}/restore`);

export const permanentDeleteNote = (id: string) =>
  request<null>('POST', `/notes/${id}/permanent-delete`);

export const batchDeleteNotes = (ids: string[]) =>
  request<{ count: number }>('POST', '/notes/batch-delete', { ids });

export const batchRestoreNotes = (ids: string[]) =>
  request<{ count: number }>('POST', '/notes/batch-restore', { ids });

export const batchPermanentDeleteNotes = (ids: string[]) =>
  request<{ count: number }>('POST', '/notes/batch-permanent-delete', { ids });

// P3.4-a: pin + reorder
export const pinNote = (id: string, pinned: boolean) =>
  request<Note>('PATCH', `/notes/${id}/pin`, { pinned });

export const reorderNotes = (folder_id: string | null, ordered_ids: string[]) =>
  request<{ count: number }>('POST', '/notes/reorder', { folder_id, ordered_ids });

// Folders
export const listFolders = () => request<Folder[]>('GET', '/folders');

export const createFolder = (data: {
  name: string;
  parent_id?: string | null;
  position?: number;
}) => request<Folder>('POST', '/folders', data);

export const updateFolder = (
  id: string,
  data: { name?: string; parent_id?: string | null; position?: number },
) => request<Folder>('PUT', `/folders/${id}`, data);

export const deleteFolder = (id: string) => request<null>('DELETE', `/folders/${id}`);

export const reorderFolders = (items: FolderReorderItem[]) =>
  request<{ count: number }>('PATCH', '/folders/reorder', { items });

export const moveNoteToFolder = (id: string, folderId: string | null) =>
  request<Note>('PATCH', `/notes/${id}/move`, { folder_id: folderId });

// Tags
export const listTags = (search?: string) => {
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  return request<Tag[]>('GET', `/tags${qs}`);
};

export const listFrequentTags = (limit?: number) => {
  const qs = limit ? `?limit=${limit}` : '';
  return request<FrequentTag[]>('GET', `/tags/frequent${qs}`);
};

export const parseTag = (raw: string) => request<ParsedTag>('POST', '/parse-tag', { raw });

// Todos
export interface TodoItem {
  line: number;
  text: string;
  checked: boolean;
}

export interface TodoGroup {
  note_id: string;
  note_title: string;
  updated_at: string;
  items: TodoItem[];
}

export const getTodos = (params?: { checked?: boolean; folder_id?: string }) => {
  const qs = new URLSearchParams();
  if (params?.checked !== undefined) qs.set('checked', String(params.checked));
  if (params?.folder_id) qs.set('folder_id', params.folder_id);
  const query = qs.toString();
  return request<TodoGroup[]>('GET', `/todos${query ? `?${query}` : ''}`);
};

export const toggleTodo = (noteId: string, line: number) =>
  request<Note>('PATCH', `/notes/${noteId}/toggle-todo`, { line });

// Reminders
export const listReminders = (from: string, to: string) =>
  request<Note[]>(
    'GET',
    `/reminders?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );

export const listUpcomingReminders = (withinMinutes?: number) => {
  const qs = withinMinutes ? `?within_minutes=${withinMinutes}` : '';
  return request<Note[]>('GET', `/reminders/upcoming${qs}`);
};

export const listAlarmNotes = () => request<Note[]>('GET', '/reminders/alarms');

// Config
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

export interface OwlConfig {
  llm: LlmConfig;
  window: { width: number; height: number };
  font: { global_offset: number; editor_font_size: number; editor_line_height: number };
  navigation: { order: string[] };
  daemon: { poll_interval_min: number; port: number };
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

export const getConfig = () => request<OwlConfig>('GET', '/config');

export const patchConfig = (delta: Partial<OwlConfig>) =>
  request<OwlConfig>('PATCH', '/config', delta);

export const testLlmConnection = (llm?: Partial<LlmConfig>) =>
  request<{ success: boolean; message: string }>('POST', '/llm/test', llm ?? {});

// ─── AI ────────────────────────────────────────────────

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

export const getAiCapabilities = () =>
  request<{ tools: AiToolDescriptor[] }>('GET', '/ai/capabilities');

export const listAiConversations = () =>
  request<{ conversations: AiConversationSummary[] }>('GET', '/ai/conversations');

export const getAiConversation = (id: string) =>
  request<AiConversationDetail>('GET', `/ai/conversations/${id}`);

export const deleteAiConversation = (id: string) =>
  request<{ id: string }>('DELETE', `/ai/conversations/${id}`);

export const listAiPreviews = () =>
  request<{ previews: AiPreviewSummary[] }>('GET', '/ai/previews');

export const applyAiPreview = (previewId: string) =>
  request<{ note_id: string; action: string; message: string }>('POST', '/ai/preview/apply', {
    preview_id: previewId,
  });

// Note: POST /ai/chat is SSE-streamed and lives in `lib/sse-client.ts`,
// invoked with `${baseUrl()}/ai/chat`.

// ─── Skybridge sync ────────────────────────────────────

export type SyncState = 'idle' | 'syncing' | 'error' | 'offline';

/**
 * Wire shape returned by `GET /sync/status`. Daemon source of truth is
 * `SyncStatusResult` in `packages/daemon/src/sync/manual.ts`. The
 * endpoint reflects configured-ness and cursor truth from sqlite; it
 * does NOT carry the live `state` / `last_error` overlay (those are
 * broadcaster-only and only show up on SSE).
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

export const getSyncStatus = () => request<SyncStatusResult>('GET', '/sync/status');

// Conflicts (P5-c §2.4)

/**
 * Wire shape of one row from `GET /conflicts`. snake_case mirrors what the
 * daemon emits straight from `conflict_record`. `local_payload` /
 * `remote_payload` are serialized JSON strings — callers JSON.parse on
 * read.
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

export const listConflicts = (limit?: number) => {
  const q = limit !== undefined ? `?limit=${limit}` : '';
  return request<{ conflicts: ConflictRecord[] }>('GET', `/conflicts${q}`);
};

export const getConflictCount = () => request<{ count: number }>('GET', '/conflicts/count');

export const ignoreConflict = (id: string) =>
  request<{ id: string; ignored: true }>('POST', `/conflicts/${id}/ignore`);

// Tag editing helpers

/** Serialize a note's tags array back to raw tag strings for API submission. */
export function tagsToStrings(tags: NoteTag[]): string[] {
  return tags.map((t) => {
    if (t.tagType === '#') return `#${t.tagValue}`;
    if (t.tagValue) return `${t.tagType} ${t.tagValue}`;
    return t.tagType;
  });
}

/** Update a single tag's value on a note (replaces the tag, keeps all others). */
export async function editTagOnNote(note: Note, tagId: string, newValue: string): Promise<void> {
  const updatedTags = note.tags.map((t) => (t.id === tagId ? { ...t, tagValue: newValue } : t));
  await patchNote(note.id, { content: note.content, tags: tagsToStrings(updatedTags) });
}
