import type { OwlBackend } from '../backend/types.js';
import { CliError } from '../lib/errors.js';
import type { OutputStreams } from '../lib/output.js';
import { writeNdjson, writeRaw, writeResult } from '../lib/output.js';
import { serializeNote } from '../lib/serialize.js';

export interface GetFlags {
  field?: string;
  raw?: boolean;
  pretty?: boolean;
}

export async function runGet(
  id: string,
  flags: GetFlags,
  deps: { backend: OwlBackend; streams: OutputStreams },
): Promise<void> {
  const note = await deps.backend.getNote(id);
  if (!note) {
    throw new CliError('NOTE_NOT_FOUND', `note ${id} not found`, { id });
  }

  // --raw is sugar for --field content
  const field = flags.raw ? 'content' : flags.field;

  if (field === 'content') {
    writeRaw(note.content, { streams: deps.streams });
    return;
  }
  if (field === 'title') {
    const serialized = serializeNote(note);
    writeRaw(String(serialized.title), { streams: deps.streams });
    return;
  }
  if (field === 'tags') {
    const serialized = serializeNote(note);
    writeNdjson(serialized.tags as string[], { streams: deps.streams });
    return;
  }
  if (field) {
    const serialized = serializeNote(note);
    const val = serialized[field as keyof typeof serialized];
    if (val === undefined) {
      throw new CliError('USAGE_ERROR', `unknown field: ${field}`, { field });
    }
    if (typeof val === 'string' || typeof val === 'number') {
      writeRaw(String(val), { streams: deps.streams });
    } else if (Array.isArray(val)) {
      writeNdjson(val, { streams: deps.streams });
    } else {
      writeResult(val, { pretty: flags.pretty, streams: deps.streams });
    }
    return;
  }

  writeResult(serializeNote(note), { pretty: flags.pretty, streams: deps.streams });
}
