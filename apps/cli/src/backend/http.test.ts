import { describe, expect, it, vi } from 'vitest';
import { CliError } from '../lib/errors.js';
import { createHttpBackend } from './http.js';

interface MockCall {
  url: string;
  method?: string;
  body?: unknown;
}

function makeFetch(response: {
  status?: number;
  body: unknown;
}): { fetch: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call: MockCall = { url: String(url), method: init?.method };
    if (init?.body) call.body = JSON.parse(init.body as string);
    calls.push(call);
    return {
      status: response.status ?? 200,
      ok: (response.status ?? 200) < 400,
      json: async () => response.body,
    } as Response;
  });
  return { fetch: fetchFn as unknown as typeof fetch, calls };
}

function noteBody(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: overrides.id ?? 'n1',
    content: overrides.content ?? 'hello',
    folderId: overrides.folderId ?? null,
    trashLevel: overrides.trashLevel ?? 0,
    createdAt: overrides.createdAt ?? '2026-05-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-05-01T00:00:01.000Z',
    trashedAt: overrides.trashedAt ?? null,
    autoDeleteAt: overrides.autoDeleteAt ?? null,
    contentHash: overrides.contentHash ?? 'sha256:deadbeef',
    tags: overrides.tags ?? [],
  };
}

const PORT = 47010;

describe('HttpBackend.getNote', () => {
  it('GETs /notes/:id and converts dates to ms', async () => {
    const { fetch, calls } = makeFetch({ body: { success: true, data: noteBody() } });
    const backend = createHttpBackend({ port: PORT, fetch });
    const note = await backend.getNote('n1');
    expect(note?.id).toBe('n1');
    expect(note?.updatedAt).toBe(Date.parse('2026-05-01T00:00:01.000Z'));
    expect(calls[0]).toMatchObject({
      url: `http://127.0.0.1:${PORT}/notes/n1`,
      method: 'GET',
    });
  });

  it('returns null on 404 (NOTE_NOT_FOUND from daemon)', async () => {
    const { fetch } = makeFetch({
      status: 404,
      body: { success: false, error_code: 'NOTE_NOT_FOUND', message: 'not found' },
    });
    const backend = createHttpBackend({ port: PORT, fetch });
    expect(await backend.getNote('missing')).toBeNull();
  });
});

describe('HttpBackend.listNotes', () => {
  it('builds query string from filter options', async () => {
    const { fetch, calls } = makeFetch({
      body: { success: true, data: [], total: 0 },
    });
    const backend = createHttpBackend({ port: PORT, fetch });
    await backend.listNotes({
      q: 'hello',
      page: 2,
      limit: 15,
      folderId: 'f1',
      tags: ['#foo', '#bar'],
      sortBy: 'created',
      sortOrder: 'asc',
      includeDescendants: false,
    });
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/notes');
    expect(url.searchParams.get('q')).toBe('hello');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('limit')).toBe('15');
    expect(url.searchParams.get('folder_id')).toBe('f1');
    expect(url.searchParams.get('tags')).toBe('#foo,#bar');
    expect(url.searchParams.get('sort_by')).toBe('created');
    expect(url.searchParams.get('sort_order')).toBe('asc');
    expect(url.searchParams.get('include_descendants')).toBe('false');
  });

  it('sends folder_id=null for unfiled filter', async () => {
    const { fetch, calls } = makeFetch({ body: { success: true, data: [], total: 0 } });
    const backend = createHttpBackend({ port: PORT, fetch });
    await backend.listNotes({ folderId: null });
    expect(new URL(calls[0].url).searchParams.get('folder_id')).toBe('null');
  });
});

describe('HttpBackend.createNote', () => {
  it('POSTs to /notes with snake_case body', async () => {
    const { fetch, calls } = makeFetch({
      body: { success: true, data: noteBody({ id: 'n-new', content: 'new' }) },
    });
    const backend = createHttpBackend({ port: PORT, fetch });
    await backend.createNote({ content: 'new', folderId: 'f1', tags: ['#a'] });
    expect(calls[0]).toMatchObject({
      url: `http://127.0.0.1:${PORT}/notes`,
      method: 'POST',
      body: { content: 'new', folder_id: 'f1', tags: ['#a'] },
    });
  });
});

describe('HttpBackend.updateNote (PATCH) with CAS', () => {
  it('sends expected_updated_at in body', async () => {
    const { fetch, calls } = makeFetch({ body: { success: true, data: noteBody() } });
    const backend = createHttpBackend({ port: PORT, fetch });
    await backend.updateNote('n1', { content: 'x' }, { expectedUpdatedAt: 1234 });
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].body).toMatchObject({ content: 'x', expected_updated_at: 1234 });
  });

  it('maps 409 VERSION_MISMATCH to CliError', async () => {
    const { fetch } = makeFetch({
      status: 409,
      body: {
        success: false,
        error_code: 'VERSION_MISMATCH',
        message: 'mismatch',
        details: { expected: 1, current: 2 },
      },
    });
    const backend = createHttpBackend({ port: PORT, fetch });
    await expect(backend.updateNote('n1', { content: 'x' })).rejects.toMatchObject({
      code: 'VERSION_MISMATCH',
      details: { expected: 1, current: 2 },
    });
  });
});

describe('HttpBackend.replaceNote (PUT)', () => {
  it('sends content + folder_id + tags together', async () => {
    const { fetch, calls } = makeFetch({ body: { success: true, data: noteBody() } });
    const backend = createHttpBackend({ port: PORT, fetch });
    await backend.replaceNote('n1', { content: 'x', folderId: null, tags: [] });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].body).toEqual({ content: 'x', folder_id: null, tags: [] });
  });
});

describe('HttpBackend.deleteNote', () => {
  it('DELETE with reject_if_trashed and expected_updated_at in body', async () => {
    const { fetch, calls } = makeFetch({
      body: { success: true, data: noteBody({ trashLevel: 1 }) },
    });
    const backend = createHttpBackend({ port: PORT, fetch });
    await backend.deleteNote('n1', { rejectIfTrashed: true, expectedUpdatedAt: 100 });
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].body).toEqual({ reject_if_trashed: true, expected_updated_at: 100 });
  });

  it('maps 409 ALREADY_TRASHED to CliError with details', async () => {
    const { fetch } = makeFetch({
      status: 409,
      body: {
        success: false,
        error_code: 'ALREADY_TRASHED',
        message: 'already trashed',
        details: { current_trash_level: 1 },
      },
    });
    const backend = createHttpBackend({ port: PORT, fetch });
    await expect(backend.deleteNote('n1', { rejectIfTrashed: true })).rejects.toMatchObject({
      code: 'ALREADY_TRASHED',
      details: { current_trash_level: 1 },
    });
  });
});

describe('HttpBackend.restoreNote', () => {
  it('POST /notes/:id/restore with expected_updated_at', async () => {
    const { fetch, calls } = makeFetch({ body: { success: true, data: noteBody() } });
    const backend = createHttpBackend({ port: PORT, fetch });
    await backend.restoreNote('n1', { expectedUpdatedAt: 42 });
    expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/notes/n1/restore`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ expected_updated_at: 42 });
  });
});

describe('HttpBackend.listFolders', () => {
  it('GETs /folders and converts to CliFolder', async () => {
    const { fetch } = makeFetch({
      body: {
        success: true,
        data: [{ id: 'f1', name: '工作', parentId: null, position: 0 }],
      },
    });
    const backend = createHttpBackend({ port: PORT, fetch });
    const result = await backend.listFolders();
    expect(result).toEqual([{ id: 'f1', name: '工作', parentId: null, position: 0 }]);
  });
});

describe('HttpBackend.listHashtagTags', () => {
  it('GETs /tags without count by default', async () => {
    const { fetch, calls } = makeFetch({
      body: {
        success: true,
        data: [{ id: 't1', tagType: '#', tagValue: 'alpha' }],
      },
    });
    const backend = createHttpBackend({ port: PORT, fetch });
    const result = await backend.listHashtagTags();
    expect(calls[0].url).toBe(`http://127.0.0.1:${PORT}/tags`);
    expect(result).toEqual([{ value: 'alpha' }]);
  });

  it('GETs /tags/frequent when frequent=true and includes count', async () => {
    const { fetch, calls } = makeFetch({
      body: {
        success: true,
        data: [{ id: 't1', tag_type: '#', tag_value: 'alpha', usage_count: 5 }],
      },
    });
    const backend = createHttpBackend({ port: PORT, fetch });
    const result = await backend.listHashtagTags({ frequent: true, limit: 20 });
    expect(calls[0].url).toContain('/tags/frequent');
    expect(calls[0].url).toContain('limit=20');
    expect(result).toEqual([{ value: 'alpha', count: 5 }]);
  });
});

describe('HttpBackend error mapping', () => {
  it('unknown error code falls back to HTTP_ERROR', async () => {
    const { fetch } = makeFetch({
      status: 500,
      body: { success: false, error_code: 'WEIRD_THING', message: 'boom' },
    });
    const backend = createHttpBackend({ port: PORT, fetch });
    try {
      await backend.getNote('x');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('HTTP_ERROR');
    }
  });
});
