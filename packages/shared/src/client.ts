// owl daemon REST API client. Every function is a thin typed wrapper over
// `request()`; the transport (base URL + auth headers) is configured by the
// host via `configureTransport`. Note: `POST /ai/chat` is SSE-streamed and
// lives in the SSE module, invoked with `baseUrl() + '/ai/chat'`.

import { request } from './transport.js';
import type {
  AiConversationDetail,
  AiConversationSummary,
  AiPreviewSummary,
  AiToolDescriptor,
  ConflictRecord,
  Folder,
  FolderReorderItem,
  FrequentTag,
  LlmConfig,
  Note,
  NoteTag,
  OwlConfig,
  ParsedTag,
  SyncStatusResult,
  Tag,
  TodoGroup,
} from './types.js';

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

// Config. These typed helpers model the local/owner happy path (full
// `OwlConfig`). A cloud daemon may return a `PublicOwlConfig` projection (no
// api_key) to a non-owner session — a Phase B web client narrows on that type
// explicitly (exported from ./types). See the OwlConfig contract note there.
export const getConfig = () => request<OwlConfig>('GET', '/config');

export const patchConfig = (delta: Partial<OwlConfig>) =>
  request<OwlConfig>('PATCH', '/config', delta);

export const testLlmConnection = (llm?: Partial<LlmConfig>) =>
  request<{ success: boolean; message: string }>('POST', '/llm/test', llm ?? {});

// AI
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

// Skybridge sync
export const getSyncStatus = () => request<SyncStatusResult>('GET', '/sync/status');

// Conflicts (P5-c §2.4)
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
