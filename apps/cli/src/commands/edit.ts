import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CasOptions,
  OwlBackend,
  ReplaceNoteInput,
  UpdateNoteInput,
} from '../backend/types.js';
import { CliError } from '../lib/errors.js';
import { resolveContentInput } from '../lib/input.js';
import type { OutputStreams } from '../lib/output.js';
import { writeResult } from '../lib/output.js';
import { serializeNote } from '../lib/serialize.js';
import { parseTagsStrict } from '../lib/tag-strict.js';

export interface EditFlags {
  body?: string;
  file?: string;
  stdin?: boolean;
  data?: string;
  dataFile?: string;
  tags?: string;
  tag?: string[];
  folder?: string;
  unfiled?: boolean;
  replace?: boolean;
  interactive?: boolean;
  overwrite?: boolean;
  ifUpdatedAt?: number;
  pretty?: boolean;
}

function toStrings(parsed: { tagType: string; tagValue: string }[]): string[] {
  return parsed.map((t) => (t.tagType === '#' ? `#${t.tagValue}` : `${t.tagType}:${t.tagValue}`));
}

function tagArgs(flags: EditFlags): string[] {
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

function folderOption(flags: EditFlags): { provided: boolean; value?: string | null } {
  if (flags.folder !== undefined && flags.unfiled) {
    throw new CliError('USAGE_ERROR', '--folder and --unfiled are mutually exclusive');
  }
  if (flags.unfiled) return { provided: true, value: null };
  if (flags.folder !== undefined) return { provided: true, value: flags.folder };
  return { provided: false };
}

async function openEditor(initialContent: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'owl-edit-'));
  const file = join(dir, 'note.md');
  writeFileSync(file, initialContent);
  const editor = process.env.EDITOR ?? 'vi';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [file], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`editor exited ${code}`)),
    );
  });
  return readFileSync(file, 'utf8');
}

type EditDeps = { backend: OwlBackend; streams: OutputStreams };
type ResolvedContent = Awaited<ReturnType<typeof resolveContentInput>>;

/** Validate mutually-exclusive edit flags before dispatching to a mode handler. */
function assertEditFlags(flags: EditFlags): void {
  if (flags.overwrite && flags.ifUpdatedAt !== undefined) {
    throw new CliError('USAGE_ERROR', '--overwrite and --if-updated-at are mutually exclusive');
  }
  if (
    flags.interactive &&
    (flags.body !== undefined || flags.file || flags.stdin || flags.data || flags.dataFile)
  ) {
    throw new CliError('USAGE_ERROR', '--interactive cannot be combined with content-source flags');
  }
}

/** CAS options from --overwrite / --if-updated-at (shared by --replace + PATCH; --overwrite wins by omitting the guard). */
function casFromFlags(flags: EditFlags): CasOptions {
  const casOpts: CasOptions = {};
  if (!flags.overwrite && flags.ifUpdatedAt !== undefined) {
    casOpts.expectedUpdatedAt = flags.ifUpdatedAt;
  }
  return casOpts;
}

/** --interactive: GET → edit in $EDITOR → PATCH with auto-CAS using the step-1 updatedAt. */
async function runInteractiveEdit(id: string, flags: EditFlags, deps: EditDeps): Promise<void> {
  const current = await deps.backend.getNote(id);
  if (!current) throw new CliError('NOTE_NOT_FOUND', `note ${id} not found`, { id });
  const newContent = await openEditor(current.content);
  const casOpts: CasOptions = flags.overwrite
    ? {}
    : { expectedUpdatedAt: flags.ifUpdatedAt ?? current.updatedAt };
  const updated = await deps.backend.updateNote(id, { content: newContent }, casOpts);
  if (!updated) throw new CliError('NOTE_NOT_FOUND', `note ${id} not found`, { id });
  writeResult(serializeNote(updated), { pretty: flags.pretty, streams: deps.streams });
}

/** Assemble the ReplaceNoteInput: full JSON payload (needs content+tags+folder) or content + explicit flags. */
function buildReplaceInput(resolved: ResolvedContent, flags: EditFlags): ReplaceNoteInput {
  if (resolved.mode === 'full') {
    if (resolved.parsed.folder_id === undefined || !resolved.parsed.tags) {
      throw new CliError(
        'USAGE_ERROR',
        '--replace requires content, tags, and folder_id in the JSON payload',
      );
    }
    return {
      content: resolved.parsed.content,
      folderId: resolved.parsed.folder_id,
      tags: resolved.parsed.tags,
    };
  }
  const folder = folderOption(flags);
  if (!folder.provided) {
    throw new CliError('USAGE_ERROR', '--replace requires --folder <id> or --unfiled');
  }
  const parsed = parseTagsStrict(tagArgs(flags));
  return { content: resolved.content, folderId: folder.value ?? null, tags: toStrings(parsed) };
}

/** --replace: strict PUT — requires a content source, then a full replacement input. */
async function runReplace(id: string, flags: EditFlags, deps: EditDeps): Promise<void> {
  const hasContentSource = flags.body !== undefined || flags.file || flags.stdin;
  const hasDataSource = flags.data !== undefined || flags.dataFile !== undefined;
  if (!hasContentSource && !hasDataSource) {
    throw new CliError(
      'USAGE_ERROR',
      '--replace requires content (--body/--file/--stdin or --data/--data-file)',
    );
  }
  const resolved = await resolveContentInput({
    body: flags.body,
    file: flags.file,
    stdin: flags.stdin,
    data: flags.data,
    dataFile: flags.dataFile,
  });
  const input = buildReplaceInput(resolved, flags);
  const updated = await deps.backend.replaceNote(id, input, casFromFlags(flags));
  if (!updated) throw new CliError('NOTE_NOT_FOUND', `note ${id} not found`, { id });
  writeResult(serializeNote(updated), { pretty: flags.pretty, streams: deps.streams });
}

/** The content-derived PATCH fields: content, plus tags/folder when a full JSON payload carries them. */
async function resolvePatchContentFields(flags: EditFlags): Promise<UpdateNoteInput> {
  const hasContentSource = flags.body !== undefined || flags.file || flags.stdin;
  const hasDataSource = flags.data !== undefined || flags.dataFile !== undefined;
  if (!hasContentSource && !hasDataSource) return {};

  const resolved = await resolveContentInput({
    body: flags.body,
    file: flags.file,
    stdin: flags.stdin,
    data: flags.data,
    dataFile: flags.dataFile,
  });
  if (resolved.mode !== 'full') return { content: resolved.content };

  const out: UpdateNoteInput = { content: resolved.parsed.content };
  if (resolved.parsed.tags !== undefined) out.tags = resolved.parsed.tags;
  if (resolved.parsed.folder_id !== undefined) out.folderId = resolved.parsed.folder_id;
  return out;
}

/** Assemble the sparse UpdateNoteInput (PATCH): content fields, then tag/folder flags fill the gaps. */
async function buildPatchUpdate(flags: EditFlags): Promise<UpdateNoteInput> {
  const update = await resolvePatchContentFields(flags);
  if (update.tags === undefined) {
    const args = tagArgs(flags);
    if (args.length > 0) update.tags = toStrings(parseTagsStrict(args));
  }
  if (update.folderId === undefined) {
    const folder = folderOption(flags);
    if (folder.provided) update.folderId = folder.value ?? null;
  }
  return update;
}

/** Default PATCH: apply the sparse update, erroring when nothing was provided. */
async function runPatch(id: string, flags: EditFlags, deps: EditDeps): Promise<void> {
  const update = await buildPatchUpdate(flags);
  if (Object.keys(update).length === 0) {
    throw new CliError(
      'USAGE_ERROR',
      'no fields to update — provide content or --tags or --folder/--unfiled',
    );
  }
  const updated = await deps.backend.updateNote(id, update, casFromFlags(flags));
  if (!updated) throw new CliError('NOTE_NOT_FOUND', `note ${id} not found`, { id });
  writeResult(serializeNote(updated), { pretty: flags.pretty, streams: deps.streams });
}

export async function runEdit(id: string, flags: EditFlags, deps: EditDeps): Promise<void> {
  assertEditFlags(flags);

  if (flags.interactive) {
    await runInteractiveEdit(id, flags, deps);
    return;
  }
  if (flags.replace) {
    await runReplace(id, flags, deps);
    return;
  }
  await runPatch(id, flags, deps);
}
