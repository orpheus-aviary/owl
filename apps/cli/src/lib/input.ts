import { readFile as fsReadFile } from 'node:fs/promises';
import { CliError } from './errors.js';

export interface ContentInputFlags {
  body?: string;
  file?: string;
  stdin?: boolean;
  data?: string;
  dataFile?: string;
}

/**
 * Shape of a `--data` / `--data-file` JSON payload. `content` is the
 * only required field; missing ones behave as "unchanged" in PATCH
 * contexts or are supplied elsewhere via flags.
 */
export interface FullInputPayload {
  content: string;
  folder_id?: string | null;
  tags?: string[];
}

export interface FullInput {
  mode: 'full';
  parsed: FullInputPayload;
}
export interface ContentInput {
  mode: 'content';
  content: string;
}
export type ResolvedInput = FullInput | ContentInput;

/** Environment hooks to keep the resolver testable. */
export interface InputEnv {
  readFile?: (path: string) => Promise<string>;
  readStdin?: () => Promise<string>;
  isStdinTty?: () => boolean;
}

async function loadContentFlag(flags: ContentInputFlags, env: InputEnv): Promise<ContentInput> {
  if (flags.body !== undefined) return { mode: 'content', content: flags.body };
  if (flags.file !== undefined) {
    const reader = env.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    return { mode: 'content', content: await reader(flags.file) };
  }
  // flags.stdin
  const reader = env.readStdin ?? readStdinDefault;
  return { mode: 'content', content: await reader() };
}

async function loadFullFlag(flags: ContentInputFlags, env: InputEnv): Promise<FullInput> {
  const raw =
    flags.data !== undefined
      ? flags.data
      : await (env.readFile ?? ((p) => fsReadFile(p, 'utf8')))(flags.dataFile as string);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CliError(
      'INVALID_JSON_INPUT',
      `failed to parse JSON payload: ${(err as Error).message}`,
    );
  }

  if (!isFullInputPayload(parsed)) {
    throw new CliError(
      'USAGE_ERROR',
      '--data / --data-file payload must include a "content" string',
    );
  }
  return { mode: 'full', parsed };
}

function isFullInputPayload(x: unknown): x is FullInputPayload {
  return (
    typeof x === 'object' &&
    x !== null &&
    'content' in x &&
    typeof (x as { content: unknown }).content === 'string'
  );
}

export async function resolveContentInput(
  flags: ContentInputFlags,
  env: InputEnv = {},
): Promise<ResolvedInput> {
  const contentSources = [flags.body !== undefined, flags.file !== undefined, flags.stdin === true];
  const fullSources = [flags.data !== undefined, flags.dataFile !== undefined];
  const contentCount = contentSources.filter(Boolean).length;
  const fullCount = fullSources.filter(Boolean).length;

  if (fullCount > 1) {
    throw new CliError('USAGE_ERROR', '--data and --data-file are mutually exclusive');
  }
  if (fullCount === 1 && contentCount > 0) {
    throw new CliError(
      'USAGE_ERROR',
      '--data / --data-file cannot be combined with --body / --file / --stdin',
    );
  }
  if (contentCount > 1) {
    throw new CliError('USAGE_ERROR', '--body, --file, and --stdin are mutually exclusive');
  }

  if (fullCount === 1) return loadFullFlag(flags, env);
  if (contentCount === 1) return loadContentFlag(flags, env);

  // Nothing given — fall back to stdin if it's piped.
  const isTty = env.isStdinTty ? env.isStdinTty() : Boolean(process.stdin.isTTY);
  if (isTty) {
    throw new CliError(
      'USAGE_ERROR',
      'no content source provided (use --body / --file / --stdin / --data / --data-file)',
    );
  }
  const reader = env.readStdin ?? readStdinDefault;
  return { mode: 'content', content: await reader() };
}

async function readStdinDefault(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
