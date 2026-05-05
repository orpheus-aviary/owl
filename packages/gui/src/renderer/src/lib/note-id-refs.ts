/**
 * P3.4-c — AI chat UUID → pill support.
 *
 * Two pieces in one module, since they share the LRU cache:
 *   1. `remarkNoteRefs` — mdast plugin that converts three AI output shapes
 *      into a single canonical `link { url: 'note:<uuid>' }` node:
 *        - bare UUID in text               → split text + insert link
 *        - UUID in single backticks        → replace inlineCode with link
 *        - `[label](<uuid>)` markdown link → rewrite `.url` to `note:<uuid>`
 *      Fenced code blocks (`code`) and `linkReference` are left alone;
 *      `link` nodes are not descended into (nested link is illegal).
 *   2. `fetchNoteMeta` — async lookup with LRU (100 entries) + in-flight
 *      de-dup so N simultaneously-mounted pills for the same id fire one
 *      request.
 *
 * Cache lives for the renderer session only (plan §7.4 accepts stale
 * titles on rename until the session restarts; upgrade to daemon-pushed
 * metadata is "方案 B" and out of scope here).
 */
import { extractTitle } from '@/components/NoteListItem';
import * as api from '@/lib/api';

// ─── Remark plugin ───────────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Exact-match variant for inlineCode / link url: matches only when the
 *  *entire* content is a single UUID (ignoring surrounding whitespace). */
const UUID_ONLY_RE = /^\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i;

const SKIP_TYPES: ReadonlySet<string> = new Set([
  'code', // fenced block: ```\nUUID\n``` — preserve code samples
  'linkReference', // [text][ref] — uncommon, and `url` resolution lives elsewhere
]);

// Minimal structural types for the mdast nodes we touch. remark passes real
// mdast (Root | Parent | Text | ...) at runtime; we accept anything with an
// optional children array plus a type tag.
interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNode[];
}

/** Remark plugin factory. Returns a transformer that rewrites the tree
 *  in-place. Kept zero-dep (no mdast-util-find-and-replace / unist-util-visit)
 *  so we don't pull a transitive into the direct dep graph. */
export function remarkNoteRefs() {
  return (tree: MdastNode): void => {
    walk(tree);
  };
}

function walk(node: MdastNode): void {
  const children = node.children;
  if (!children || children.length === 0) return;
  const out: MdastNode[] = [];
  for (const child of children) {
    if (SKIP_TYPES.has(child.type)) {
      out.push(child);
      continue;
    }
    // `[text](<bare-uuid>)` — rewrite url to `note:<uuid>`. Don't descend
    // into children (would nest links). Non-UUID urls pass through.
    if (child.type === 'link') {
      if (typeof child.url === 'string' && UUID_ONLY_RE.test(child.url)) {
        child.url = `note:${child.url.trim()}`;
      }
      out.push(child);
      continue;
    }
    // Inline-code that is entirely one UUID → replace with link node.
    // Mixed inline code (e.g. `id = <uuid>`) passes through unchanged.
    if (child.type === 'inlineCode' && typeof child.value === 'string') {
      if (UUID_ONLY_RE.test(child.value)) {
        const uuid = child.value.trim();
        out.push(makeLink(uuid));
      } else {
        out.push(child);
      }
      continue;
    }
    if (child.type === 'text' && typeof child.value === 'string') {
      out.push(...splitOnUuid(child.value));
    } else {
      walk(child);
      out.push(child);
    }
  }
  node.children = out;
}

function makeLink(uuid: string): MdastNode {
  return {
    type: 'link',
    url: `note:${uuid}`,
    children: [{ type: 'text', value: uuid }],
  };
}

function splitOnUuid(value: string): MdastNode[] {
  const matches = Array.from(value.matchAll(UUID_RE));
  if (matches.length === 0) return [{ type: 'text', value }];
  const out: MdastNode[] = [];
  let cursor = 0;
  for (const m of matches) {
    const start = m.index ?? 0;
    if (start > cursor) out.push({ type: 'text', value: value.slice(cursor, start) });
    out.push(makeLink(m[0]));
    cursor = start + m[0].length;
  }
  if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) });
  return out;
}

// ─── LRU cache + fetch with in-flight de-dup ─────────────

export type NoteMeta =
  | { status: 'loading' }
  | { status: 'ok'; title: string }
  | { status: 'trashed'; title: string }
  | { status: 'missing' };

const CACHE_MAX = 100;
const cache = new Map<string, NoteMeta>();
const pending = new Map<string, Promise<NoteMeta>>();

/** LRU read: returns a cached meta and bumps it to most-recent. */
export function noteMetaCacheGet(id: string): NoteMeta | undefined {
  const meta = cache.get(id);
  if (meta === undefined) return undefined;
  cache.delete(id);
  cache.set(id, meta);
  return meta;
}

function cacheSet(id: string, meta: NoteMeta): void {
  if (cache.has(id)) cache.delete(id);
  cache.set(id, meta);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Test-only. Both caches are module singletons so tests must reset between
 *  cases to avoid order-dependent pollution. */
export function _resetNoteIdCachesForTest(): void {
  cache.clear();
  pending.clear();
}

/**
 * Resolve note meta for a pill. Cache hit → synchronous-ish via microtask;
 * miss → one fetch shared across concurrent callers for the same id.
 *
 * Throws on non-404 network / server errors. Callers (NoteIdPill) must
 * `.catch()` to avoid unhandled rejections — those errors are not cached so
 * a remount retries naturally.
 */
export async function fetchNoteMeta(id: string): Promise<NoteMeta> {
  const hit = noteMetaCacheGet(id);
  if (hit !== undefined) return hit;
  const existing = pending.get(id);
  if (existing) return existing;
  const promise = runFetch(id);
  pending.set(id, promise);
  return promise;
}

async function runFetch(id: string): Promise<NoteMeta> {
  try {
    const res = await api.getNote(id);
    const note = res.data;
    if (!note) {
      const m: NoteMeta = { status: 'missing' };
      cacheSet(id, m);
      return m;
    }
    const title = extractTitle(note.content);
    const m: NoteMeta =
      note.trashLevel > 0 ? { status: 'trashed', title } : { status: 'ok', title };
    cacheSet(id, m);
    return m;
  } catch (err) {
    if (err instanceof api.ApiError && err.status === 404) {
      const m: NoteMeta = { status: 'missing' };
      cacheSet(id, m);
      return m;
    }
    throw err;
  } finally {
    pending.delete(id);
  }
}
