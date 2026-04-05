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

  return null;
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
 * Extract raw tag strings from note content.
 *
 * Finds: #hashtags, /time ..., /alarm ..., /daily, /weekly, /monthly, /yearly
 */
export function extractTagsFromContent(content: string): string[] {
  const tags: string[] = [];

  // Hashtags: #word (Unicode word chars, no spaces)
  for (const m of content.matchAll(/(^|[\s,;])#([\p{L}\p{N}_\-]+)/gu)) {
    tags.push(`#${m[2]}`);
  }

  // Time/alarm tags: /time ... or /alarm ... (consume until end of line or next tag)
  for (const m of content.matchAll(/(?:^|[\s])(\/(?:time|alarm))[\s:]+([^\n#/]+)/gm)) {
    tags.push(`${m[1]} ${m[2].trim()}`);
  }

  // Frequency modifiers
  for (const m of content.matchAll(/(?:^|[\s])(\/(?:daily|weekly|monthly|yearly))(?=[\s,;]|$)/gm)) {
    tags.push(m[1]);
  }

  return tags;
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

  // Try to split into date and time parts (space or T separator)
  const parts = trimmed.split(/[\sT]+/);

  let datePart: string | null = null;
  let timePart: string | null = null;

  if (parts.length === 2) {
    datePart = parts[0];
    timePart = parts[1];
  } else if (parts.length === 1) {
    // Could be just date or just time
    if (parts[0].includes('-')) {
      datePart = parts[0];
    } else if (parts[0].includes(':')) {
      timePart = parts[0];
    } else {
      return null;
    }
  } else {
    return null;
  }

  let year: number;
  let month: number;
  let day: number;
  let hour: number;
  let minute: number;
  let second: number;

  // Parse time
  if (timePart) {
    const timeParts = timePart.split(':').map(Number);
    if (timeParts.some((n) => Number.isNaN(n))) return null;
    hour = timeParts[0];
    minute = timeParts[1] ?? 0;
    second = timeParts[2] ?? 0;
  } else {
    hour = 23;
    minute = 59;
    second = 59;
  }

  // Parse date
  if (datePart) {
    const dateParts = datePart.split('-').map(Number);
    if (dateParts.some((n) => Number.isNaN(n))) return null;

    if (dateParts.length === 3) {
      // YYYY-MM-DD or YY-MM-DD
      year = dateParts[0] < 100 ? 2000 + dateParts[0] : dateParts[0];
      month = dateParts[1];
      day = dateParts[2];
    } else if (dateParts.length === 2) {
      // MM-DD → infer year
      month = dateParts[0];
      day = dateParts[1];
      const candidate = new Date(now.getFullYear(), month - 1, day, hour, minute, second);
      year = candidate.getTime() >= now.getTime() ? now.getFullYear() : now.getFullYear() + 1;
    } else {
      return null;
    }
  } else {
    // Time only → infer today or tomorrow
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, second);
    if (today.getTime() >= now.getTime()) {
      year = now.getFullYear();
      month = now.getMonth() + 1;
      day = now.getDate();
    } else {
      const tomorrow = new Date(today.getTime() + 86400000);
      year = tomorrow.getFullYear();
      month = tomorrow.getMonth() + 1;
      day = tomorrow.getDate();
    }
  }

  // Validate
  const result = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(result.getTime())) return null;

  // Format as ISO-like string: YYYY-MM-DDTHH:MM:SS
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
}
