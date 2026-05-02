import type { CasOptions, OwlBackend } from '../backend/types.js';
import { CliError } from '../lib/errors.js';
import { resolveContentInput } from '../lib/input.js';
import type { OutputStreams } from '../lib/output.js';
import { writeResult } from '../lib/output.js';
import { serializeNote } from '../lib/serialize.js';

export interface AppendFlags {
  body?: string;
  stdin?: boolean;
  separator?: string;
  noNewline?: boolean;
  overwrite?: boolean;
  ifUpdatedAt?: number;
  pretty?: boolean;
}

export async function runAppend(
  id: string,
  flags: AppendFlags,
  deps: { backend: OwlBackend; streams: OutputStreams },
): Promise<void> {
  if (flags.overwrite && flags.ifUpdatedAt !== undefined) {
    throw new CliError('USAGE_ERROR', '--overwrite and --if-updated-at are mutually exclusive');
  }

  const resolved = await resolveContentInput({ body: flags.body, stdin: flags.stdin });
  if (resolved.mode !== 'content') {
    throw new CliError('USAGE_ERROR', 'append only accepts --body / --stdin content input');
  }
  const appendText = resolved.content;

  // Step 1: read current note (for baseline + content)
  const current = await deps.backend.getNote(id);
  if (!current) throw new CliError('NOTE_NOT_FOUND', `note ${id} not found`, { id });

  const separator = flags.separator ?? '\n\n';
  const base = current.content;
  const newContent = flags.noNewline
    ? base + appendText
    : base.endsWith('\n') || base === ''
      ? base + appendText
      : base + separator + appendText;

  // Step 3: determine expected_updated_at per §4.3 priority
  const casOpts: CasOptions = flags.overwrite
    ? {}
    : { expectedUpdatedAt: flags.ifUpdatedAt ?? current.updatedAt };

  const updated = await deps.backend.updateNote(id, { content: newContent }, casOpts);
  if (!updated) throw new CliError('NOTE_NOT_FOUND', `note ${id} disappeared mid-append`, { id });
  writeResult(serializeNote(updated), { pretty: flags.pretty, streams: deps.streams });
}
