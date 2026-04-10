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
  deviceId: string | null;
  contentHash: string | null;
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

// ─── API Client ─────────────────────────────────────────

declare global {
  interface Window {
    owlAPI: { daemonUrl: string };
  }
}

function baseUrl(): string {
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
  trash_level?: number;
  tags?: string;
  sort_by?: 'updated' | 'created';
  sort_order?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}) {
  const qs = new URLSearchParams();
  if (params?.q) qs.set('q', params.q);
  if (params?.folder_id) qs.set('folder_id', params.folder_id);
  if (params?.trash_level !== undefined) qs.set('trash_level', String(params.trash_level));
  if (params?.tags) qs.set('tags', params.tags);
  if (params?.sort_by) qs.set('sort_by', params.sort_by);
  if (params?.sort_order) qs.set('sort_order', params.sort_order);
  if (params?.page) qs.set('page', String(params.page));
  if (params?.limit) qs.set('limit', String(params.limit));
  const query = qs.toString();
  return request<Note[]>('GET', `/notes${query ? `?${query}` : ''}`);
}

export const getNote = (id: string) => request<Note>('GET', `/notes/${id}`);

export const createNote = (data: { content: string; folder_id?: string; tags?: string[] }) =>
  request<Note>('POST', '/notes', data);

export const updateNote = (id: string, data: { content: string; tags?: string[] }) =>
  request<Note>('PUT', `/notes/${id}`, data);

export const patchNote = (
  id: string,
  data: { content?: string; folder_id?: string | null; tags?: string[] },
) => request<Note>('PATCH', `/notes/${id}`, data);

export const deleteNote = (id: string) => request<null>('DELETE', `/notes/${id}`);

export const restoreNote = (id: string) => request<null>('POST', `/notes/${id}/restore`);

export const permanentDeleteNote = (id: string) =>
  request<null>('POST', `/notes/${id}/permanent-delete`);

export const batchDeleteNotes = (ids: string[]) =>
  request<{ count: number }>('POST', '/notes/batch-delete', { ids });

export const batchRestoreNotes = (ids: string[]) =>
  request<{ count: number }>('POST', '/notes/batch-restore', { ids });

export const batchPermanentDeleteNotes = (ids: string[]) =>
  request<{ count: number }>('POST', '/notes/batch-permanent-delete', { ids });

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
  const updatedTags = note.tags.map((t) =>
    t.id === tagId ? { ...t, tagValue: newValue } : t,
  );
  await updateNote(note.id, { content: note.content, tags: tagsToStrings(updatedTags) });
}
