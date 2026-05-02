import type { CreateNoteInput, OwlBackend } from '../backend/types.js';
import { CliError } from '../lib/errors.js';
import { resolveContentInput } from '../lib/input.js';
import type { OutputStreams } from '../lib/output.js';
import { writeResult } from '../lib/output.js';
import { serializeNote } from '../lib/serialize.js';
import { parseTagsStrict } from '../lib/tag-strict.js';

export interface CreateFlags {
  body?: string;
  file?: string;
  stdin?: boolean;
  data?: string;
  dataFile?: string;
  tags?: string;
  tag?: string[];
  folder?: string;
  unfiled?: boolean;
  pretty?: boolean;
}

function collectTagArgs(flags: CreateFlags): string[] {
  const out: string[] = [];
  if (flags.tag?.length) out.push(...flags.tag);
  if (flags.tags)
    out.push(
      ...flags.tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  return out;
}

function resolveFolderId(flags: CreateFlags): string | null | undefined {
  if (flags.folder !== undefined && flags.unfiled) {
    throw new CliError('USAGE_ERROR', '--folder and --unfiled are mutually exclusive');
  }
  if (flags.unfiled) return null;
  if (flags.folder !== undefined) return flags.folder;
  return undefined;
}

export async function runCreate(
  flags: CreateFlags,
  deps: { backend: OwlBackend; streams: OutputStreams },
): Promise<void> {
  const resolved = await resolveContentInput({
    body: flags.body,
    file: flags.file,
    stdin: flags.stdin,
    data: flags.data,
    dataFile: flags.dataFile,
  });

  let input: CreateNoteInput;
  if (resolved.mode === 'full') {
    // --data / --data-file cannot be combined with tag/folder flags; input.ts enforces
    // content-source mutex but tag/folder are separate. Guard explicitly:
    if (flags.tag?.length || flags.tags || flags.folder !== undefined || flags.unfiled) {
      throw new CliError(
        'USAGE_ERROR',
        '--data / --data-file cannot be combined with --tags / --tag / --folder / --unfiled',
      );
    }
    input = {
      content: resolved.parsed.content,
      folderId: resolved.parsed.folder_id ?? null,
      tags: resolved.parsed.tags ?? [],
    };
  } else {
    const tagArgs = collectTagArgs(flags);
    const parsed = parseTagsStrict(tagArgs);
    const tagStrings = parsed.map((t) =>
      t.tagType === '#' ? `#${t.tagValue}` : `${t.tagType}:${t.tagValue}`,
    );
    const folderId = resolveFolderId(flags);
    input = {
      content: `${resolved.content.trimEnd()}\n`,
      tags: tagStrings,
      ...(folderId !== undefined ? { folderId } : {}),
    };
  }

  const created = await deps.backend.createNote(input);
  writeResult(serializeNote(created), { pretty: flags.pretty, streams: deps.streams });
}
