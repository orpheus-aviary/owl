import { type NoteWithTags, listNotes, searchNotesWithDetails } from '@owl/core';
import type { ToolDef } from '../tool-registry.js';
import { getBoolean, getNullableString, getNumber, getString, getStringArray } from './args.js';

const MAX_NOTES = 50;
const DEFAULT_MAX_CHARS = 8000;
const SNIPPET_HEAD = 200;

export const searchNotesTool: ToolDef = {
  name: 'search_notes',
  description:
    "Search the user's notes by full-text query, optionally filtered by tags or folder. " +
    'Empty `query` returns the most recently updated notes. Returns a list ranked by relevance, ' +
    'truncating long bodies to ~200 chars and stopping once cumulative content exceeds `max_chars` ' +
    '(default 8000). Use this when the system-prompt context (which already includes very recent ' +
    'notes) does not contain what you need.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'FTS5 query. Empty string falls back to recent notes by updated_at.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '`#` hashtag values (without the leading #) to AND-filter on.',
      },
      folder_id: {
        type: ['string', 'null'],
        description: 'Folder id to scope the search; null means root/unfiled.',
      },
      include_descendants: {
        type: 'boolean',
        description:
          'When folder_id is set, include notes inside descendant folders. Default true.',
      },
      max_chars: {
        type: 'number',
        description: `Cumulative character budget for returned bodies (default ${DEFAULT_MAX_CHARS}).`,
      },
      limit: {
        type: 'number',
        description: `Max notes to return (default 20, hard-capped at ${MAX_NOTES}).`,
      },
    },
  },
  async execute(args, ctx) {
    const query = (getString(args, 'query') ?? '').trim();
    const tags = getStringArray(args, 'tags');
    const folderId = getNullableString(args, 'folder_id');
    const includeDescendants = getBoolean(args, 'include_descendants') ?? true;
    const maxChars = getNumber(args, 'max_chars') ?? DEFAULT_MAX_CHARS;
    const limit = Math.min(getNumber(args, 'limit') ?? 20, MAX_NOTES);

    const notes = query
      ? filterNotes(searchNotesWithDetails(ctx.db, ctx.sqlite, query, limit), {
          tags,
          folderId,
        })
      : listNotes(ctx.db, ctx.sqlite, {
          tagValues: tags,
          folderId,
          includeDescendants,
          sortBy: 'updated',
          sortOrder: 'desc',
          limit,
        }).items;

    return formatSearchResults(notes, maxChars);
  },
};

interface FilterOptions {
  tags: string[] | undefined;
  folderId: string | null | undefined;
}

/**
 * In-memory filter applied to FTS results. We can't push these into FTS5
 * itself without a more involved query rewrite, and the result set is
 * already capped at `limit` so the cost is negligible.
 */
function filterNotes(notes: NoteWithTags[], opts: FilterOptions): NoteWithTags[] {
  return notes.filter((n) => {
    if (opts.folderId !== undefined && n.folderId !== opts.folderId) return false;
    if (opts.tags && opts.tags.length > 0) {
      const noteTagValues = n.tags.filter((t) => t.tagType === '#').map((t) => t.tagValue ?? '');
      for (const required of opts.tags) {
        if (!noteTagValues.includes(required)) return false;
      }
    }
    return true;
  });
}

interface SearchResultEntry {
  id: string;
  folder_id: string | null;
  updated_at: string;
  tags: string[];
  snippet: string;
  truncated: boolean;
}

interface SearchToolOutput {
  matches: SearchResultEntry[];
  total_returned: number;
  truncated_by_budget: boolean;
}

function formatSearchResults(notes: NoteWithTags[], maxChars: number): SearchToolOutput {
  const matches: SearchResultEntry[] = [];
  let consumed = 0;
  let truncatedByBudget = false;

  for (const n of notes) {
    if (consumed >= maxChars) {
      truncatedByBudget = true;
      break;
    }
    const isLong = n.content.length > SNIPPET_HEAD;
    const snippet = isLong ? `${n.content.slice(0, SNIPPET_HEAD)}…` : n.content;
    consumed += snippet.length;
    matches.push({
      id: n.id,
      folder_id: n.folderId,
      updated_at: n.updatedAt.toISOString(),
      tags: n.tags.map(formatTag),
      snippet,
      truncated: isLong,
    });
  }

  return {
    matches,
    total_returned: matches.length,
    truncated_by_budget: truncatedByBudget,
  };
}

function formatTag(t: { tagType: string; tagValue: string | null }): string {
  if (t.tagType === '#') return `#${t.tagValue ?? ''}`;
  return t.tagValue ? `${t.tagType} ${t.tagValue}` : t.tagType;
}
