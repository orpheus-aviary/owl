import { ApiError } from '@/lib/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock api + NoteListItem deps BEFORE importing the module under test so the
// mock is in place when note-id-refs's own imports resolve.
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    getNote: vi.fn(),
  };
});

import * as api from '@/lib/api';
import { fetchNoteMeta, noteMetaCacheGet, remarkNoteRefs, resetNoteIdCaches } from './note-id-refs';

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

beforeEach(() => {
  resetNoteIdCaches();
  vi.clearAllMocks();
});
afterEach(() => {
  resetNoteIdCaches();
});

const ID1 = '11111111-2222-3333-4444-555555555555';
const ID2 = '66666666-7777-8888-9999-aaaaaaaaaaaa';

// ─── remarkNoteRefs ──────────────────────────────────────

describe('remarkNoteRefs — rewrites bare UUIDs in text nodes', () => {
  const transform = (tree: Node) => {
    remarkNoteRefs()(tree);
    return tree;
  };

  // Narrowing helper — tests want to assert on the rewritten tree, so we
  // assume (and re-assert via `expect`) that children arrays are present
  // rather than sprinkle `!` through every test.
  const kids = (node: Node): Node[] => {
    expect(node.children).toBeDefined();
    return node.children as Node[];
  };

  it('replaces a bare UUID with a link node', () => {
    const tree: Node = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: `see ${ID1} now` }],
        },
      ],
    };
    transform(tree);
    const para = kids(tree)[0];
    const paraKids = kids(para);
    expect(paraKids).toHaveLength(3);
    expect(paraKids[0]).toMatchObject({ type: 'text', value: 'see ' });
    expect(paraKids[1]).toMatchObject({
      type: 'link',
      url: `note:${ID1}`,
    });
    expect(paraKids[1].children).toEqual([{ type: 'text', value: ID1 }]);
    expect(paraKids[2]).toMatchObject({ type: 'text', value: ' now' });
  });

  it('replaces multiple UUIDs in one text node', () => {
    const tree: Node = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: `a ${ID1} b ${ID2} c` }],
        },
      ],
    };
    transform(tree);
    const paraKids = kids(kids(tree)[0]);
    expect(paraKids.map((n) => n.type)).toEqual(['text', 'link', 'text', 'link', 'text']);
    expect(paraKids[1].url).toBe(`note:${ID1}`);
    expect(paraKids[3].url).toBe(`note:${ID2}`);
  });

  it('leaves text untouched when no UUID matches', () => {
    const tree: Node = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'text', value: 'nothing special here' }],
        },
      ],
    };
    transform(tree);
    expect(kids(kids(tree)[0])).toEqual([{ type: 'text', value: 'nothing special here' }]);
  });

  it('does NOT descend into code blocks (preserves example UUIDs)', () => {
    const tree: Node = {
      type: 'root',
      children: [{ type: 'code', value: `id = ${ID1}` }],
    };
    transform(tree);
    expect(kids(tree)[0]).toEqual({ type: 'code', value: `id = ${ID1}` });
  });

  it('converts inlineCode whose whole content is a UUID into a link (AI commonly wraps ids in backticks)', () => {
    const tree: Node = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'inlineCode', value: ID1 }],
        },
      ],
    };
    transform(tree);
    expect(kids(kids(tree)[0])).toEqual([
      {
        type: 'link',
        url: `note:${ID1}`,
        children: [{ type: 'text', value: ID1 }],
      },
    ]);
  });

  it('also converts inlineCode wrapping a UUID with surrounding whitespace', () => {
    const tree: Node = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'inlineCode', value: ` ${ID1} ` }] }],
    };
    transform(tree);
    const first = kids(kids(tree)[0])[0];
    expect(first.type).toBe('link');
    expect(first.url).toBe(`note:${ID1}`);
  });

  it('leaves mixed-content inlineCode alone (not just a UUID)', () => {
    const tree: Node = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [{ type: 'inlineCode', value: `id = ${ID1}` }],
        },
      ],
    };
    transform(tree);
    expect(kids(kids(tree)[0])).toEqual([{ type: 'inlineCode', value: `id = ${ID1}` }]);
  });

  it('rewrites [text](<bare-uuid>) link URLs to note:<uuid> (AI often uses link syntax)', () => {
    const tree: Node = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: ID1,
              children: [{ type: 'text', value: '个人主页' }],
            },
          ],
        },
      ],
    };
    transform(tree);
    const link = kids(kids(tree)[0])[0];
    expect(link.type).toBe('link');
    expect(link.url).toBe(`note:${ID1}`);
    // children preserved (label isn't touched — pill ignores them anyway).
    expect(link.children).toEqual([{ type: 'text', value: '个人主页' }]);
  });

  it('leaves non-UUID link URLs alone (external links keep working)', () => {
    const tree: Node = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'link',
              url: 'https://example.com/page',
              children: [{ type: 'text', value: 'docs' }],
            },
          ],
        },
      ],
    };
    transform(tree);
    const link = kids(kids(tree)[0])[0];
    expect(link.url).toBe('https://example.com/page');
  });

  it('does NOT descend into existing link (would produce illegal nested link)', () => {
    const existingLink: Node = {
      type: 'link',
      url: 'https://example.com',
      children: [{ type: 'text', value: `click ${ID1}` }],
    };
    const tree: Node = {
      type: 'root',
      children: [{ type: 'paragraph', children: [existingLink] }],
    };
    transform(tree);
    const preserved = kids(kids(tree)[0])[0];
    expect(preserved.type).toBe('link');
    // Inner text still contains the raw UUID — it was NOT split into
    // a nested pill link (markdown forbids nested links).
    expect(preserved.children).toEqual([{ type: 'text', value: `click ${ID1}` }]);
  });

  it('does NOT descend into linkReference', () => {
    const tree: Node = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'linkReference',
              children: [{ type: 'text', value: ID1 }],
            },
          ],
        },
      ],
    };
    transform(tree);
    const ref = kids(kids(tree)[0])[0];
    expect(ref.type).toBe('linkReference');
    expect(ref.children).toEqual([{ type: 'text', value: ID1 }]);
  });

  it('descends into emphasis/strong (nested inline should pill-ify)', () => {
    const tree: Node = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'strong',
              children: [{ type: 'text', value: ID1 }],
            },
          ],
        },
      ],
    };
    transform(tree);
    const strong = kids(kids(tree)[0])[0];
    expect(strong.children).toEqual([
      { type: 'link', url: `note:${ID1}`, children: [{ type: 'text', value: ID1 }] },
    ]);
  });

  it('matches UUIDs case-insensitively', () => {
    const upper = ID1.toUpperCase();
    const tree: Node = {
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: `X ${upper} Y` }] }],
    };
    transform(tree);
    const link = kids(kids(tree)[0])[1];
    expect(link.type).toBe('link');
    expect(link.url).toBe(`note:${upper}`);
  });
});

// ─── LRU cache ───────────────────────────────────────────

describe('noteMetaCacheGet / cacheSet (LRU)', () => {
  it('evicts oldest after exceeding CACHE_MAX (100)', async () => {
    const getNoteMock = vi.mocked(api.getNote);
    // Populate 101 distinct ids.
    for (let i = 0; i < 101; i++) {
      const id = `${i.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
      getNoteMock.mockResolvedValueOnce({
        success: true,
        data: {
          id,
          content: `# note ${i}`,
          trashLevel: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          folderId: null,
          pinnedAt: null,
          position: null,
          tags: [],
        } as unknown as api.Note,
      });
      await fetchNoteMeta(id);
    }
    // First inserted id should be evicted.
    const first = '00000000-0000-0000-0000-000000000000';
    expect(noteMetaCacheGet(first)).toBeUndefined();
    // Last inserted id should still be there.
    const last = '00000064-0000-0000-0000-000000000000'; // 100 in hex
    expect(noteMetaCacheGet(last)).toBeDefined();
  });

  it('bumps recently-read entry to most-recent (LRU semantics)', async () => {
    const getNoteMock = vi.mocked(api.getNote);
    const mkNote = (id: string) =>
      ({
        success: true,
        data: {
          id,
          content: `# ${id}`,
          trashLevel: 0,
          createdAt: '',
          updatedAt: '',
          folderId: null,
          pinnedAt: null,
          position: null,
          tags: [],
        },
      }) as unknown as Awaited<ReturnType<typeof api.getNote>>;

    // Seed 100 entries.
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const id = `${i.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
      ids.push(id);
      getNoteMock.mockResolvedValueOnce(mkNote(id));
      await fetchNoteMeta(id);
    }
    // Read the very first — it should be bumped to most-recent.
    expect(noteMetaCacheGet(ids[0])).toBeDefined();

    // Insert the 101st. Now ids[1] (which is second-oldest after the bump)
    // should be evicted, not ids[0].
    const newId = '0000ffff-0000-0000-0000-000000000000';
    getNoteMock.mockResolvedValueOnce(mkNote(newId));
    await fetchNoteMeta(newId);

    expect(noteMetaCacheGet(ids[0])).toBeDefined(); // survived
    expect(noteMetaCacheGet(ids[1])).toBeUndefined(); // evicted
  });
});

// ─── fetchNoteMeta ───────────────────────────────────────

describe('fetchNoteMeta', () => {
  it('returns ok with extracted title for a live note', async () => {
    vi.mocked(api.getNote).mockResolvedValue({
      success: true,
      data: {
        id: ID1,
        content: '# Hello world\n\nbody',
        trashLevel: 0,
        createdAt: '',
        updatedAt: '',
        folderId: null,
        pinnedAt: null,
        position: null,
        tags: [],
      } as unknown as api.Note,
    });
    const meta = await fetchNoteMeta(ID1);
    expect(meta).toEqual({ status: 'ok', title: 'Hello world' });
  });

  it('returns trashed with title when trashLevel > 0', async () => {
    vi.mocked(api.getNote).mockResolvedValue({
      success: true,
      data: {
        id: ID1,
        content: '# Gone\n',
        trashLevel: 1,
        createdAt: '',
        updatedAt: '',
        folderId: null,
        pinnedAt: null,
        position: null,
        tags: [],
      } as unknown as api.Note,
    });
    const meta = await fetchNoteMeta(ID1);
    expect(meta).toEqual({ status: 'trashed', title: 'Gone' });
  });

  it('returns missing on 404', async () => {
    vi.mocked(api.getNote).mockRejectedValue(new ApiError(404, undefined, 'Not found'));
    const meta = await fetchNoteMeta(ID1);
    expect(meta).toEqual({ status: 'missing' });
  });

  it('de-dups concurrent callers for the same id to one fetch', async () => {
    const getNoteMock = vi.mocked(api.getNote);
    let resolve: (v: Awaited<ReturnType<typeof api.getNote>>) => void = () => {};
    getNoteMock.mockReturnValue(
      new Promise<Awaited<ReturnType<typeof api.getNote>>>((r) => {
        resolve = r;
      }),
    );

    const promises = [
      fetchNoteMeta(ID1),
      fetchNoteMeta(ID1),
      fetchNoteMeta(ID1),
      fetchNoteMeta(ID1),
      fetchNoteMeta(ID1),
    ];
    expect(getNoteMock).toHaveBeenCalledTimes(1);
    resolve({
      success: true,
      data: {
        id: ID1,
        content: '# T',
        trashLevel: 0,
        createdAt: '',
        updatedAt: '',
        folderId: null,
        pinnedAt: null,
        position: null,
        tags: [],
      } as unknown as api.Note,
    });
    const results = await Promise.all(promises);
    for (const r of results) expect(r).toEqual({ status: 'ok', title: 'T' });
  });

  it('does NOT cache non-404 errors — next call retries', async () => {
    const getNoteMock = vi.mocked(api.getNote);
    getNoteMock.mockRejectedValueOnce(new Error('network'));
    await expect(fetchNoteMeta(ID1)).rejects.toThrow('network');
    // Second call: cache must be empty so a new request fires.
    getNoteMock.mockResolvedValueOnce({
      success: true,
      data: {
        id: ID1,
        content: '# OK',
        trashLevel: 0,
        createdAt: '',
        updatedAt: '',
        folderId: null,
        pinnedAt: null,
        position: null,
        tags: [],
      } as unknown as api.Note,
    });
    const meta = await fetchNoteMeta(ID1);
    expect(meta).toEqual({ status: 'ok', title: 'OK' });
    expect(getNoteMock).toHaveBeenCalledTimes(2);
  });

  it('serves subsequent calls from LRU cache without refetching', async () => {
    const getNoteMock = vi.mocked(api.getNote);
    getNoteMock.mockResolvedValueOnce({
      success: true,
      data: {
        id: ID1,
        content: '# Once',
        trashLevel: 0,
        createdAt: '',
        updatedAt: '',
        folderId: null,
        pinnedAt: null,
        position: null,
        tags: [],
      } as unknown as api.Note,
    });
    await fetchNoteMeta(ID1);
    await fetchNoteMeta(ID1);
    await fetchNoteMeta(ID1);
    expect(getNoteMock).toHaveBeenCalledTimes(1);
  });
});
