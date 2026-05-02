import { type DaemonFailBody, mapHttpError } from '../lib/errors.js';
import type {
  CasOptions,
  CliFolder,
  CliHashtagTag,
  CliNote,
  CliNoteTag,
  CreateNoteInput,
  DeleteNoteOptions,
  ListHashtagTagsOptions,
  ListNotesQuery,
  NoteListResult,
  OwlBackend,
  ReplaceNoteInput,
  UpdateNoteInput,
} from './types.js';

export interface HttpBackendOptions {
  port: number;
  fetch?: typeof fetch;
}

interface DaemonEnvelope<T> {
  success?: boolean;
  data?: T;
  total?: number;
  error_code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

// ─── Wire → CliNote conversion ───────────────────────────

interface WireTag {
  id?: string;
  tagType?: string;
  tag_type?: string;
  tagValue?: string;
  tag_value?: string;
}

interface WireNote {
  id: string;
  content: string;
  folderId?: string | null;
  folder_id?: string | null;
  trashLevel?: number;
  trash_level?: number;
  createdAt: string | number;
  created_at?: string | number;
  updatedAt: string | number;
  updated_at?: string | number;
  trashedAt?: string | number | null;
  trashed_at?: string | number | null;
  autoDeleteAt?: string | number | null;
  auto_delete_at?: string | number | null;
  contentHash?: string | null;
  content_hash?: string | null;
  tags?: WireTag[];
}

function toMs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v);
  throw new Error(`cannot coerce to ms: ${JSON.stringify(v)}`);
}

function toMsOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : toMs(v);
}

function toTag(w: WireTag): CliNoteTag {
  return {
    id: w.id ?? '',
    tagType: w.tagType ?? w.tag_type ?? '',
    tagValue: w.tagValue ?? w.tag_value ?? '',
  };
}

function toNote(w: WireNote): CliNote {
  return {
    id: w.id,
    content: w.content,
    folderId: w.folderId ?? w.folder_id ?? null,
    trashLevel: w.trashLevel ?? w.trash_level ?? 0,
    createdAt: toMs(w.createdAt ?? w.created_at),
    updatedAt: toMs(w.updatedAt ?? w.updated_at),
    trashedAt: toMsOrNull(w.trashedAt ?? w.trashed_at),
    autoDeleteAt: toMsOrNull(w.autoDeleteAt ?? w.auto_delete_at),
    contentHash: w.contentHash ?? w.content_hash ?? null,
    tags: (w.tags ?? []).map(toTag),
  };
}

// ─── Backend impl ────────────────────────────────────────

export function createHttpBackend(opts: HttpBackendOptions): OwlBackend {
  const base = `http://127.0.0.1:${opts.port}`;
  const doFetch = opts.fetch ?? fetch;

  async function request<T>(
    method: string,
    path: string,
    init: { body?: unknown } = {},
  ): Promise<{ status: number; envelope: DaemonEnvelope<T> }> {
    const hasBody = init.body !== undefined;
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(init.body) : undefined,
    });
    const envelope = (await res.json()) as DaemonEnvelope<T>;
    return { status: res.status, envelope };
  }

  function failOrThrow<T>(status: number, envelope: DaemonEnvelope<T>): T {
    if (status >= 400 || envelope.success === false) {
      throw mapHttpError(status, envelope as DaemonFailBody);
    }
    // biome-ignore lint/style/noNonNullAssertion: envelope.data is guaranteed on success
    return envelope.data!;
  }

  /** Some endpoints (get / update / …) treat NOTE_NOT_FOUND as null rather than throw. */
  function asNullableNote<T>(status: number, envelope: DaemonEnvelope<T>): T | null {
    if (envelope.success === false && envelope.error_code === 'NOTE_NOT_FOUND') return null;
    return failOrThrow(status, envelope);
  }

  return {
    mode: 'http',

    async listNotes(query: ListNotesQuery): Promise<NoteListResult> {
      const qs = new URLSearchParams();
      if (query.q !== undefined) qs.set('q', query.q);
      if (query.page !== undefined) qs.set('page', String(query.page));
      if (query.limit !== undefined) qs.set('limit', String(query.limit));
      if (query.folderId !== undefined) {
        qs.set('folder_id', query.folderId === null ? 'null' : query.folderId);
      }
      if (query.includeDescendants !== undefined) {
        qs.set('include_descendants', String(query.includeDescendants));
      }
      if (query.tags?.length) qs.set('tags', query.tags.join(','));
      if (query.trashLevel !== undefined) qs.set('trash_level', String(query.trashLevel));
      if (query.sortBy) qs.set('sort_by', query.sortBy);
      if (query.sortOrder) qs.set('sort_order', query.sortOrder);
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const { status, envelope } = await request<WireNote[]>('GET', `/notes${suffix}`);
      const items = failOrThrow(status, envelope).map(toNote);
      return {
        items,
        total: envelope.total ?? items.length,
        page: query.page ?? 1,
        limit: query.limit ?? 20,
      };
    },

    async getNote(id: string): Promise<CliNote | null> {
      const { status, envelope } = await request<WireNote>('GET', `/notes/${id}`);
      const data = asNullableNote(status, envelope);
      return data ? toNote(data) : null;
    },

    async createNote(input: CreateNoteInput): Promise<CliNote> {
      const { status, envelope } = await request<WireNote>('POST', '/notes', {
        body: {
          content: input.content,
          folder_id: input.folderId ?? null,
          tags: input.tags ?? [],
        },
      });
      return toNote(failOrThrow(status, envelope));
    },

    async updateNote(
      id: string,
      input: UpdateNoteInput,
      casOpts?: CasOptions,
    ): Promise<CliNote | null> {
      const body: Record<string, unknown> = {};
      if (input.content !== undefined) body.content = input.content;
      if (input.folderId !== undefined) body.folder_id = input.folderId;
      if (input.tags !== undefined) body.tags = input.tags;
      if (casOpts?.expectedUpdatedAt !== undefined) {
        body.expected_updated_at = casOpts.expectedUpdatedAt;
      }
      const { status, envelope } = await request<WireNote>('PATCH', `/notes/${id}`, { body });
      const data = asNullableNote(status, envelope);
      return data ? toNote(data) : null;
    },

    async replaceNote(
      id: string,
      input: ReplaceNoteInput,
      casOpts?: CasOptions,
    ): Promise<CliNote | null> {
      const body: Record<string, unknown> = {
        content: input.content,
        folder_id: input.folderId,
        tags: input.tags,
      };
      if (casOpts?.expectedUpdatedAt !== undefined) {
        body.expected_updated_at = casOpts.expectedUpdatedAt;
      }
      const { status, envelope } = await request<WireNote>('PUT', `/notes/${id}`, { body });
      const data = asNullableNote(status, envelope);
      return data ? toNote(data) : null;
    },

    async deleteNote(id: string, opts?: DeleteNoteOptions): Promise<CliNote | null> {
      const body: Record<string, unknown> = {};
      if (opts?.expectedUpdatedAt !== undefined) body.expected_updated_at = opts.expectedUpdatedAt;
      if (opts?.rejectIfTrashed) body.reject_if_trashed = true;
      const { status, envelope } = await request<WireNote>('DELETE', `/notes/${id}`, { body });
      const data = asNullableNote(status, envelope);
      return data ? toNote(data) : null;
    },

    async restoreNote(id: string, opts?: CasOptions): Promise<CliNote | null> {
      const body: Record<string, unknown> = {};
      if (opts?.expectedUpdatedAt !== undefined) body.expected_updated_at = opts.expectedUpdatedAt;
      const { status, envelope } = await request<WireNote>('POST', `/notes/${id}/restore`, {
        body,
      });
      if (envelope.success === false && envelope.error_code === 'RESTORE_FAILED') return null;
      const data = asNullableNote(status, envelope);
      return data ? toNote(data) : null;
    },

    async listFolders(): Promise<CliFolder[]> {
      const { status, envelope } = await request<
        Array<{
          id: string;
          name: string;
          parentId?: string | null;
          parent_id?: string | null;
          position?: number;
        }>
      >('GET', '/folders');
      const raw = failOrThrow(status, envelope);
      return raw.map((r) => ({
        id: r.id,
        name: r.name,
        parentId: r.parentId ?? r.parent_id ?? null,
        position: r.position ?? 0,
      }));
    },

    async listHashtagTags(opts?: ListHashtagTagsOptions): Promise<CliHashtagTag[]> {
      const endpoint = opts?.frequent ? '/tags/frequent' : '/tags';
      const qs = new URLSearchParams();
      if (opts?.frequent && opts.limit !== undefined) qs.set('limit', String(opts.limit));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const { status, envelope } = await request<
        Array<{
          id?: string;
          tagType?: string;
          tag_type?: string;
          tagValue?: string;
          tag_value?: string;
          usage_count?: number;
          usageCount?: number;
        }>
      >('GET', `${endpoint}${suffix}`);
      const raw = failOrThrow(status, envelope);
      return raw.map((r) => {
        const value = r.tagValue ?? r.tag_value ?? '';
        const out: CliHashtagTag = { value };
        const count = r.usage_count ?? r.usageCount;
        if (count !== undefined) out.count = count;
        return out;
      });
    },

    async close(): Promise<void> {
      // HTTP backend holds no resources
    },
  };
}
