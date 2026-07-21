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
import { currentGen, isStale } from '@/stores/session-epoch';

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
    out.push(...rewriteChild(child));
  }
  node.children = out;
}

/** Rewrite one child node into its replacement node(s) (recursing into non-leaf children). */
function rewriteChild(child: MdastNode): MdastNode[] {
  if (SKIP_TYPES.has(child.type)) return [child];

  // `[text](<bare-uuid>)` — rewrite url to `note:<uuid>`. Don't descend into
  // children (would nest links). Non-UUID urls pass through.
  if (child.type === 'link') {
    if (typeof child.url === 'string' && UUID_ONLY_RE.test(child.url)) {
      child.url = `note:${child.url.trim()}`;
    }
    return [child];
  }

  // Inline-code that is entirely one UUID → replace with link node. Mixed inline
  // code (e.g. `id = <uuid>`) passes through unchanged.
  if (child.type === 'inlineCode' && typeof child.value === 'string') {
    return UUID_ONLY_RE.test(child.value) ? [makeLink(child.value.trim())] : [child];
  }

  if (child.type === 'text' && typeof child.value === 'string') {
    return splitOnUuid(child.value);
  }

  walk(child);
  return [child];
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

/**
 * ③: clear both module-singleton caches on a session switch (`resetAllStores`).
 * Also used by tests, which must reset between cases to avoid order-dependent
 * pollution.
 */
export function resetNoteIdCaches(): void {
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
  // ③: delete pending by promise IDENTITY, not just by id — a session switch
  // resets `pending`, and a fresh generation may enqueue a new promise for the
  // same id. Deleting unconditionally would drop the new generation's entry.
  const promise = runFetch(id).finally(() => {
    if (pending.get(id) === promise) pending.delete(id);
  });
  pending.set(id, promise);
  return promise;
}

async function runFetch(id: string): Promise<NoteMeta> {
  // ③: the module-level `cache` is session-scoped. Capture the gen so a fetch
  // that resolves after a session switch never writes an old account's title
  // into the new session's cache (the returned meta is harmless — its only
  // caller is the now-unmounted pill).
  const gen = currentGen();
  try {
    const res = await api.getNote(id);
    const note = res.data;
    if (!note) {
      const m: NoteMeta = { status: 'missing' };
      if (!isStale(gen)) cacheSet(id, m);
      return m;
    }
    const title = extractTitle(note.content);
    const m: NoteMeta =
      note.trashLevel > 0 ? { status: 'trashed', title } : { status: 'ok', title };
    if (!isStale(gen)) cacheSet(id, m);
    return m;
  } catch (err) {
    if (err instanceof api.ApiError && err.status === 404) {
      const m: NoteMeta = { status: 'missing' };
      if (!isStale(gen)) cacheSet(id, m);
      return m;
    }
    throw err;
  }
}
