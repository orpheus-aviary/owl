import type { OwlBackend } from '../backend/types.js';
import type { OutputStreams } from '../lib/output.js';
import { writeNdjson, writeRaw, writeResult } from '../lib/output.js';
import { serializeFolder, serializeHashtag } from '../lib/serialize.js';

export interface FoldersListFlags {
  idOnly?: boolean;
  ndjson?: boolean;
  pretty?: boolean;
}

export async function runFoldersList(
  flags: FoldersListFlags,
  deps: { backend: OwlBackend; streams: OutputStreams },
): Promise<void> {
  const items = (await deps.backend.listFolders()).map(serializeFolder);
  if (flags.idOnly) {
    for (const item of items) writeRaw(String(item.id), { streams: deps.streams });
    return;
  }
  if (flags.ndjson) {
    writeNdjson(items, { streams: deps.streams });
    return;
  }
  writeResult({ items }, { pretty: flags.pretty, streams: deps.streams });
}

export interface TagsListFlags {
  frequent?: boolean;
  limit?: number;
  valueOnly?: boolean;
  pretty?: boolean;
}

export async function runTagsList(
  flags: TagsListFlags,
  deps: { backend: OwlBackend; streams: OutputStreams },
): Promise<void> {
  const opts: { frequent?: boolean; limit?: number } = {};
  if (flags.frequent) opts.frequent = true;
  if (flags.limit !== undefined) opts.limit = flags.limit;
  const rows = await deps.backend.listHashtagTags(opts);

  if (flags.valueOnly) {
    for (const t of rows) writeRaw(`#${t.value}`, { streams: deps.streams });
    return;
  }
  writeResult(
    { items: rows.map(serializeHashtag) },
    { pretty: flags.pretty, streams: deps.streams },
  );
}
