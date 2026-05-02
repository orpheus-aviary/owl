import type { CasOptions, DeleteNoteOptions, OwlBackend } from '../backend/types.js';
import { CliError } from '../lib/errors.js';
import type { OutputStreams } from '../lib/output.js';
import { writeResult } from '../lib/output.js';
import { serializeNote } from '../lib/serialize.js';

export interface DeleteFlags {
  overwrite?: boolean;
  ifUpdatedAt?: number;
  pretty?: boolean;
}

export async function runDelete(
  id: string,
  flags: DeleteFlags,
  deps: { backend: OwlBackend; streams: OutputStreams },
): Promise<void> {
  if (flags.overwrite && flags.ifUpdatedAt !== undefined) {
    throw new CliError('USAGE_ERROR', '--overwrite and --if-updated-at are mutually exclusive');
  }
  const opts: DeleteNoteOptions = { rejectIfTrashed: true };
  if (!flags.overwrite && flags.ifUpdatedAt !== undefined)
    opts.expectedUpdatedAt = flags.ifUpdatedAt;
  const deleted = await deps.backend.deleteNote(id, opts);
  if (!deleted) throw new CliError('NOTE_NOT_FOUND', `note ${id} not found`, { id });
  writeResult(serializeNote(deleted), { pretty: flags.pretty, streams: deps.streams });
}

export interface RestoreFlags {
  overwrite?: boolean;
  ifUpdatedAt?: number;
  pretty?: boolean;
}

export async function runRestore(
  id: string,
  flags: RestoreFlags,
  deps: { backend: OwlBackend; streams: OutputStreams },
): Promise<void> {
  if (flags.overwrite && flags.ifUpdatedAt !== undefined) {
    throw new CliError('USAGE_ERROR', '--overwrite and --if-updated-at are mutually exclusive');
  }
  const opts: CasOptions = {};
  if (!flags.overwrite && flags.ifUpdatedAt !== undefined)
    opts.expectedUpdatedAt = flags.ifUpdatedAt;
  const restored = await deps.backend.restoreNote(id, opts);
  if (!restored)
    throw new CliError('NOTE_NOT_FOUND', `note ${id} not found or not in trash`, { id });
  writeResult(serializeNote(restored), { pretty: flags.pretty, streams: deps.streams });
}
