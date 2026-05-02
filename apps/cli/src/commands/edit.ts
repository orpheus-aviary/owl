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

export async function runEdit(
  id: string,
  flags: EditFlags,
  deps: { backend: OwlBackend; streams: OutputStreams },
): Promise<void> {
  if (flags.overwrite && flags.ifUpdatedAt !== undefined) {
    throw new CliError('USAGE_ERROR', '--overwrite and --if-updated-at are mutually exclusive');
  }
  if (
    flags.interactive &&
    (flags.body !== undefined || flags.file || flags.stdin || flags.data || flags.dataFile)
  ) {
    throw new CliError('USAGE_ERROR', '--interactive cannot be combined with content-source flags');
  }

  // --interactive: GET → edit in $EDITOR → PATCH with auto-CAS using step-1 updatedAt
  if (flags.interactive) {
    const current = await deps.backend.getNote(id);
    if (!current) throw new CliError('NOTE_NOT_FOUND', `note ${id} not found`, { id });
    const newContent = await openEditor(current.content);
    const casOpts: CasOptions = flags.overwrite
      ? {}
      : { expectedUpdatedAt: flags.ifUpdatedAt ?? current.updatedAt };
    const updated = await deps.backend.updateNote(id, { content: newContent }, casOpts);
    if (!updated) throw new CliError('NOTE_NOT_FOUND', `note ${id} not found`, { id });
    writeResult(serializeNote(updated), { pretty: flags.pretty, streams: deps.streams });
    return;
  }

  const hasContentSource = flags.body !== undefined || flags.file || flags.stdin;
  const hasDataSource = flags.data !== undefined || flags.dataFile !== undefined;

  if (flags.replace) {
    // Strict PUT: must have content + tags + folder
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
    let input: ReplaceNoteInput;
    if (resolved.mode === 'full') {
      if (resolved.parsed.folder_id === undefined || !resolved.parsed.tags) {
        throw new CliError(
          'USAGE_ERROR',
          '--replace requires content, tags, and folder_id in the JSON payload',
        );
      }
      input = {
        content: resolved.parsed.content,
        folderId: resolved.parsed.folder_id,
        tags: resolved.parsed.tags,
      };
    } else {
      const folder = folderOption(flags);
      if (!folder.provided) {
        throw new CliError('USAGE_ERROR', '--replace requires --folder <id> or --unfiled');
      }
      const parsed = parseTagsStrict(tagArgs(flags));
      input = {
        content: resolved.content,
        folderId: folder.value ?? null,
        tags: toStrings(parsed),
      };
    }
    const casOpts: CasOptions = {};
    if (!flags.overwrite && flags.ifUpdatedAt !== undefined)
      casOpts.expectedUpdatedAt = flags.ifUpdatedAt;
    const updated = await deps.backend.replaceNote(id, input, casOpts);
    if (!updated) throw new CliError('NOTE_NOT_FOUND', `note ${id} not found`, { id });
    writeResult(serializeNote(updated), { pretty: flags.pretty, streams: deps.streams });
    return;
  }

  // PATCH semantics: only fields provided get updated.
  const update: UpdateNoteInput = {};
  if (hasContentSource || hasDataSource) {
    const resolved = await resolveContentInput({
      body: flags.body,
      file: flags.file,
      stdin: flags.stdin,
      data: flags.data,
      dataFile: flags.dataFile,
    });
    if (resolved.mode === 'full') {
      update.content = resolved.parsed.content;
      if (resolved.parsed.tags !== undefined) update.tags = resolved.parsed.tags;
      if (resolved.parsed.folder_id !== undefined) update.folderId = resolved.parsed.folder_id;
    } else {
      update.content = resolved.content;
    }
  }
  if (update.tags === undefined) {
    const args = tagArgs(flags);
    if (args.length > 0) update.tags = toStrings(parseTagsStrict(args));
  }
  if (update.folderId === undefined) {
    const folder = folderOption(flags);
    if (folder.provided) update.folderId = folder.value ?? null;
  }

  if (Object.keys(update).length === 0) {
    throw new CliError(
      'USAGE_ERROR',
      'no fields to update — provide content or --tags or --folder/--unfiled',
    );
  }

  const casOpts: CasOptions = {};
  if (!flags.overwrite && flags.ifUpdatedAt !== undefined)
    casOpts.expectedUpdatedAt = flags.ifUpdatedAt;
  const updated = await deps.backend.updateNote(id, update, casOpts);
  if (!updated) throw new CliError('NOTE_NOT_FOUND', `note ${id} not found`, { id });
  writeResult(serializeNote(updated), { pretty: flags.pretty, streams: deps.streams });
}
