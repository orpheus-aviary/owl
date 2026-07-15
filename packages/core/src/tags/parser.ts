/**
 * Tag types supported by owl.
 * - '#' : text hashtag (e.g. #工作)
 * - '/time' : auto-delete time
 * - '/alarm' : reminder alarm
 * - '/daily', '/weekly', '/monthly', '/yearly' : frequency modifiers for alarms
 */
export const TAG_TYPES = [
  '#',
  '/time',
  '/alarm',
  '/daily',
  '/weekly',
  '/monthly',
  '/yearly',
] as const;
export type TagType = (typeof TAG_TYPES)[number];

export interface ParsedTag {
  tagType: TagType;
  tagValue: string;
}

/**
 * Parse a raw tag string into a structured tag.
 *
 * Examples:
 *   "#工作"       → { tagType: '#', tagValue: '工作' }
 *   "/time 2026-04-10 14:30" → { tagType: '/time', tagValue: '2026-04-10T14:30:00' }
 *   "/alarm 04-10 14:30"     → { tagType: '/alarm', tagValue: inferred ISO string }
 *   "/daily"      → { tagType: '/daily', tagValue: '' }
 */
export function parseTag(raw: string): ParsedTag | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Hashtag
  if (trimmed.startsWith('#')) {
    const value = trimmed.slice(1).trim();
    if (!value) return null;
    return { tagType: '#', tagValue: value };
  }

  // Frequency modifiers (no value)
  for (const freq of ['/daily', '/weekly', '/monthly', '/yearly'] as const) {
    if (trimmed.toLowerCase() === freq) {
      return { tagType: freq, tagValue: '' };
    }
  }

  // Time-based tags
  if (trimmed.startsWith('/time') || trimmed.startsWith('/alarm')) {
    return parseTimeTag(trimmed);
  }

  return null;
}

/** Parse a `/time …` or `/alarm …` tag (caller has confirmed the prefix). */
function parseTimeTag(trimmed: string): ParsedTag | null {
  const isAlarm = trimmed.startsWith('/alarm');
  const tagType: TagType = isAlarm ? '/alarm' : '/time';
  const dateStr = trimmed
    .slice(isAlarm ? 6 : 5)
    .replace(/^:/, '')
    .trim();

  if (!dateStr) return { tagType, tagValue: '' };

  const parsed = inferDateTime(dateStr);
  if (!parsed) return null;

  return { tagType, tagValue: parsed };
}

/**
 * Parse multiple tag strings.
 */
export function parseTags(rawTags: string[]): ParsedTag[] {
  const results: ParsedTag[] = [];
  for (const raw of rawTags) {
    const parsed = parseTag(raw);
    if (parsed) results.push(parsed);
  }
  return results;
}

/**
 * Infer a full ISO 8601 datetime from a potentially abbreviated input.
 *
 * Supported formats:
 *   YYYY-MM-DD HH:MM:SS  → direct
 *   YYYY-MM-DD HH:MM     → seconds default 0
 *   YYYY-MM-DD            → time defaults to 23:59:59
 *   YY-MM-DD HH:MM       → year prefix 20
 *   MM-DD HH:MM           → infer year (current or next)
 *   MM-DD                  → infer year, time 23:59:59
 *   HH:MM                 → infer today or tomorrow
 *   HH:MM:SS              → infer today or tomorrow
 */
export function inferDateTime(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const now = new Date();

  const split = splitDateTimeParts(trimmed);
  if (!split) return null;

  const time = parseTimePart(split.timePart);
  if (!time) return null;

  const date = parseDatePart(split.datePart, time, now);
  if (!date) return null;

  const { hour, minute, second } = time;
  const { year, month, day } = date;

  // Validate
  const result = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(result.getTime())) return null;

  // Format as ISO-like string: YYYY-MM-DDTHH:MM:SS
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

interface TimeOfDay {
  hour: number;
  minute: number;
  second: number;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** Split on space/`T` into date + time parts; a lone token is date (has `-`) or time (has `:`). */
function splitDateTimeParts(
  trimmed: string,
): { datePart: string | null; timePart: string | null } | null {
  const parts = trimmed.split(/[\sT]+/);
  if (parts.length === 2) {
    return { datePart: parts[0], timePart: parts[1] };
  }
  if (parts.length === 1) {
    if (parts[0].includes('-')) return { datePart: parts[0], timePart: null };
    if (parts[0].includes(':')) return { datePart: null, timePart: parts[0] };
    return null;
  }
  return null;
}

/** Parse `HH[:MM[:SS]]`; absent time defaults to end-of-day 23:59:59. */
function parseTimePart(timePart: string | null): TimeOfDay | null {
  if (!timePart) return { hour: 23, minute: 59, second: 59 };
  const timeParts = timePart.split(':').map(Number);
  if (timeParts.some((n) => Number.isNaN(n))) return null;
  return { hour: timeParts[0], minute: timeParts[1] ?? 0, second: timeParts[2] ?? 0 };
}

/**
 * Parse the date part, inferring the year when abbreviated. With no date part
 * (time-only input), infer today or tomorrow relative to `now`. The `time` of
 * day is needed for the MM-DD / time-only "current or next" comparison.
 */
function parseDatePart(datePart: string | null, time: TimeOfDay, now: Date): DateParts | null {
  if (datePart) {
    const dateParts = datePart.split('-').map(Number);
    if (dateParts.some((n) => Number.isNaN(n))) return null;

    if (dateParts.length === 3) {
      // YYYY-MM-DD or YY-MM-DD
      const year = dateParts[0] < 100 ? 2000 + dateParts[0] : dateParts[0];
      return { year, month: dateParts[1], day: dateParts[2] };
    }
    if (dateParts.length === 2) {
      // MM-DD → infer year (current or next)
      const month = dateParts[0];
      const day = dateParts[1];
      const candidate = new Date(
        now.getFullYear(),
        month - 1,
        day,
        time.hour,
        time.minute,
        time.second,
      );
      const year = candidate.getTime() >= now.getTime() ? now.getFullYear() : now.getFullYear() + 1;
      return { year, month, day };
    }
    return null;
  }

  // Time only → infer today or tomorrow
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    time.hour,
    time.minute,
    time.second,
  );
  if (today.getTime() >= now.getTime()) {
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }
  const tomorrow = new Date(today.getTime() + 86400000);
  return { year: tomorrow.getFullYear(), month: tomorrow.getMonth() + 1, day: tomorrow.getDate() };
}
