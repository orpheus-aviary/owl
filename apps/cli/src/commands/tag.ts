import type { CasOptions, OwlBackend } from '../backend/types.js';
import { CliError } from '../lib/errors.js';
import type { OutputStreams } from '../lib/output.js';
import { writeResult } from '../lib/output.js';
import { serializeNote } from '../lib/serialize.js';
import { parseTagsStrict } from '../lib/tag-strict.js';

export interface TagFlags {
  add?: string[];
  remove?: string[];
  overwrite?: boolean;
  ifUpdatedAt?: number;
  pretty?: boolean;
}

/** Turn a CliNoteTag into the sigil-prefixed string form expected by the backend. */
function tagToString(t: { tagType: string; tagValue: string }): string {
  return t.tagType === '#' ? `#${t.tagValue}` : `${t.tagType}:${t.tagValue}`;
}

export async function runTag(
  id: string,
  flags: TagFlags,
  deps: { backend: OwlBackend; streams: OutputStreams },
): Promise<void> {
  if (flags.overwrite && flags.ifUpdatedAt !== undefined) {
    throw new CliError('USAGE_ERROR', '--overwrite and --if-updated-at are mutually exclusive');
  }
  if (!flags.add?.length && !flags.remove?.length) {
    throw new CliError('USAGE_ERROR', 'provide at least one --add or --remove');
  }

  const current = await deps.backend.getNote(id);
  if (!current) throw new CliError('NOTE_NOT_FOUND', `note ${id} not found`, { id });

  // Remove (set-difference by rendered string form).
  const removeStrings = new Set(parseTagsStrict(flags.remove ?? []).map(tagToString));
  const retained = current.tags.filter((t) => !removeStrings.has(tagToString(t)));

  // Union with --add (dedupe on rendered string).
  const addParsed = parseTagsStrict(flags.add ?? []);
  const byKey = new Map<string, { tagType: string; tagValue: string }>();
  for (const t of retained) byKey.set(tagToString(t), t);
  for (const t of addParsed) byKey.set(tagToString(t), t);

  const newTagStrings = [...byKey.values()].map(tagToString);

  const casOpts: CasOptions = flags.overwrite
    ? {}
    : { expectedUpdatedAt: flags.ifUpdatedAt ?? current.updatedAt };

  const updated = await deps.backend.updateNote(id, { tags: newTagStrings }, casOpts);
  if (!updated) throw new CliError('NOTE_NOT_FOUND', `note ${id} disappeared mid-tag`, { id });
  writeResult(serializeNote(updated), { pretty: flags.pretty, streams: deps.streams });
}
