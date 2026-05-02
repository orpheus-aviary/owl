import { CliError } from './errors.js';

export interface OutputStreams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

function resolveStreams(opts?: { streams?: OutputStreams }): OutputStreams {
  return opts?.streams ?? { stdout: process.stdout, stderr: process.stderr };
}

function writeLine(stream: NodeJS.WritableStream, s: string): void {
  stream.write(s.endsWith('\n') ? s : `${s}\n`);
}

/** Compact (default) or pretty JSON result → stdout. */
export function writeResult(
  data: unknown,
  opts?: { pretty?: boolean; streams?: OutputStreams },
): void {
  const { stdout } = resolveStreams(opts);
  const json = opts?.pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  writeLine(stdout, json);
}

/** Plain text → stdout. Adds a trailing newline only if one is missing. */
export function writeRaw(text: string, opts?: { streams?: OutputStreams }): void {
  const { stdout } = resolveStreams(opts);
  writeLine(stdout, text);
}

/** NDJSON → stdout (one JSON object per line). */
export function writeNdjson(items: readonly unknown[], opts?: { streams?: OutputStreams }): void {
  const { stdout } = resolveStreams(opts);
  for (const item of items) stdout.write(`${JSON.stringify(item)}\n`);
}

/** Structured progress line → stderr. Never touches stdout. */
export function writeProgress(data: unknown, opts?: { streams?: OutputStreams }): void {
  const { stderr } = resolveStreams(opts);
  writeLine(stderr, JSON.stringify(data));
}

/**
 * Emit `{ error: { code, message, details? } }` to stderr. CliError code
 * is preserved; plain `Error` is bucketed as UNKNOWN.
 */
export function writeError(err: Error, opts?: { streams?: OutputStreams }): void {
  const { stderr } = resolveStreams(opts);
  const isCli = err instanceof CliError;
  const code = isCli ? err.code : 'UNKNOWN';
  const body: { error: { code: string; message: string; details?: Record<string, unknown> } } = {
    error: { code, message: err.message },
  };
  if (isCli && err.details !== undefined) body.error.details = err.details;
  writeLine(stderr, JSON.stringify(body));
}
