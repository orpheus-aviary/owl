import { type ParsedTag, parseTag, parseTags } from '@owl/core';
import { CliError } from './errors.js';

/**
 * Normalize and strict-parse a flat tag-value list for CLI input.
 *
 * Normalization: bare words (no leading `#` / `/`) are promoted to
 * hashtags — `工作` becomes `#工作`. This lets humans and agents write
 * `--tags 工作,项目A` without having to remember the sigil.
 *
 * Strictness: the returned array must match the input length. Any input
 * that fails core `parseTag` (empty string, lone `#`, unknown `/foo:bar`,
 * …) is collected under `details.bad` and an `INVALID_TAG` `CliError`
 * is raised. Core `parseTags` itself stays lenient so AI tools can keep
 * their best-effort semantics unchanged.
 */
export function parseTagsStrict(inputs: readonly string[]): ParsedTag[] {
  if (inputs.length === 0) return [];

  const normalized = inputs.map((raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return raw; // preserve empties so they land in `bad`
    if (trimmed.startsWith('#') || trimmed.startsWith('/')) return trimmed;
    return `#${trimmed}`;
  });

  const parsed = parseTags(normalized);
  if (parsed.length === normalized.length) return parsed;

  // Length mismatch — rebuild the bad list by reprobing each normalized entry.
  const bad: string[] = [];
  for (const n of normalized) {
    if (!parseTag(n)) bad.push(n);
  }
  throw new CliError(
    'INVALID_TAG',
    bad.length === 1 ? `tag "${bad[0]}" is invalid` : `${bad.length} tags could not be parsed`,
    { bad },
  );
}
