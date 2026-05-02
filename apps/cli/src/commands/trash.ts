import type { OwlBackend } from '../backend/types.js';
import type { OutputStreams } from '../lib/output.js';
import { writeNdjson, writeRaw, writeResult } from '../lib/output.js';
import { serializeSearchItem } from '../lib/serialize.js';

export interface TrashListFlags {
  level?: 1 | 2;
  limit?: number;
  page?: number;
  idOnly?: boolean;
  ndjson?: boolean;
  pretty?: boolean;
}

export async function runTrashList(
  flags: TrashListFlags,
  deps: { backend: OwlBackend; streams: OutputStreams },
): Promise<void> {
  const level = flags.level ?? 1;
  const result = await deps.backend.listNotes({
    trashLevel: level,
    ...(flags.limit !== undefined ? { limit: flags.limit } : {}),
    ...(flags.page !== undefined ? { page: flags.page } : {}),
  });
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
