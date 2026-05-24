/**
 * P5-c §6.27 — token redaction helper.
 *
 * `pino.redact` covers structured fields (`{ token, auth: { token } }`),
 * but it can't reach into raw strings that callers occasionally splat
 * via `${maybeContainsToken}`. This helper is for those: pre-mask the
 * string before it goes anywhere a token shouldn't.
 *
 * Strategy: keep a short prefix + suffix for diagnostics ("tok_abc…xyz"
 * is still useful when comparing two log lines), redact the middle. If
 * the input is shorter than the prefix+suffix budget we redact the
 * whole thing — there's no safe partial mask of a 6-char token.
 *
 * Not security-grade. Defence-in-depth alongside the structured-field
 * `pino.redact` paths and the `chmod 0600` on the source toml. The CI
 * grep守卫 (`scripts/check-token-not-templated.sh`) is the *primary*
 * line of defence; this helper exists for the cases where the grep
 * can't statically prove a string is safe and we want to redact at
 * runtime as belt-and-suspenders.
 */

const DEFAULT_VISIBLE_PREFIX = 4;
const DEFAULT_VISIBLE_SUFFIX = 4;
const FULL_MASK = '[REDACTED]';

export interface RedactTokenOptions {
  /** Characters to keep at the start (default 4). */
  prefix?: number;
  /** Characters to keep at the end (default 4). */
  suffix?: number;
}

/**
 * Mask the middle of `token`, leaving `prefix`+`suffix` characters visible
 * for diagnostics. Strings shorter than `prefix+suffix+2` collapse to
 * `[REDACTED]` so we never emit a recoverable substring.
 *
 * `null` / `undefined` / empty / non-string passes return `[REDACTED]` to
 * cover the "log line had no token at all" path without surprising the
 * caller with an empty string in the middle of a sentence.
 */
export function redactToken(value: unknown, opts: RedactTokenOptions = {}): string {
  if (typeof value !== 'string' || value.length === 0) return FULL_MASK;
  const prefix = opts.prefix ?? DEFAULT_VISIBLE_PREFIX;
  const suffix = opts.suffix ?? DEFAULT_VISIBLE_SUFFIX;
  if (prefix < 0 || suffix < 0) {
    throw new RangeError('redactToken: prefix and suffix must be non-negative');
  }
  if (value.length < prefix + suffix + 2) return FULL_MASK;
  // String.prototype.slice(-0) returns the entire string, not '' — guard it.
  const tail = suffix === 0 ? '' : value.slice(-suffix);
  return `${value.slice(0, prefix)}…${tail}`;
}
