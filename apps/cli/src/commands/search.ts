import type { OwlBackend } from '../backend/types.js';
import type { ListNotesQuery } from '../backend/types.js';
import type { OutputStreams } from '../lib/output.js';
import { writeNdjson, writeRaw, writeResult } from '../lib/output.js';
import { serializeSearchItem } from '../lib/serialize.js';

export interface SearchFlags {
  limit?: number;
  page?: number;
  folder?: string;
  unfiled?: boolean;
  tag?: string[];
  noIncludeDescendants?: boolean;
  sortBy?: 'updated' | 'created';
  sortOrder?: 'asc' | 'desc';
  idOnly?: boolean;
  ndjson?: boolean;
  pretty?: boolean;
}

export async function runSearch(
  query: string | undefined,
  flags: SearchFlags,
  deps: { backend: OwlBackend; streams: OutputStreams },
): Promise<void> {
  const listQuery: ListNotesQuery = {};
  if (query) listQuery.q = query;
  if (flags.limit !== undefined) listQuery.limit = flags.limit;
  if (flags.page !== undefined) listQuery.page = flags.page;
  if (flags.unfiled) listQuery.folderId = null;
  else if (flags.folder !== undefined) listQuery.folderId = flags.folder;
  if (flags.tag?.length) listQuery.tags = flags.tag;
  if (flags.noIncludeDescendants) listQuery.includeDescendants = false;
  if (flags.sortBy) listQuery.sortBy = flags.sortBy;
  if (flags.sortOrder) listQuery.sortOrder = flags.sortOrder;

  const result = await deps.backend.listNotes(listQuery);
  const items = result.items.map(serializeSearchItem);

  if (flags.idOnly) {
    for (const item of items) writeRaw(String(item.id), { streams: deps.streams });
    return;
  }
  if (flags.ndjson) {
    writeNdjson(items, { streams: deps.streams });
    return;
  }
  writeResult(
    { total: result.total, items, limit: result.limit, page: result.page },
    { pretty: flags.pretty, streams: deps.streams },
  );
}
