import type { Note, NoteTag } from './api';

export type TimeRange = 'today' | 'week' | 'month' | '7d' | '30d' | 'all';

export type Frequency = '/daily' | '/weekly' | '/monthly' | '/yearly';

const FREQUENCIES: readonly string[] = ['/daily', '/weekly', '/monthly', '/yearly'];

const FREQUENCY_LABELS: Record<Frequency, string> = {
  '/daily': '每日',
  '/weekly': '每周',
  '/monthly': '每月',
  '/yearly': '每年',
};

export function getFrequencyLabel(freq: Frequency): string {
  return FREQUENCY_LABELS[freq];
}

/** Compute the next occurrence of an alarm, advancing by frequency if needed. */
export function getNextOccurrence(
  alarmTime: Date,
  frequency: Frequency | null,
  now: Date,
): Date | null {
  if (!frequency) {
    return alarmTime > now ? alarmTime : null;
  }
  const next = new Date(alarmTime);
  while (next <= now) {
    switch (frequency) {
      case '/daily':
        next.setDate(next.getDate() + 1);
        break;
      case '/weekly':
        next.setDate(next.getDate() + 7);
        break;
      case '/monthly':
        next.setMonth(next.getMonth() + 1);
        break;
      case '/yearly':
        next.setFullYear(next.getFullYear() + 1);
        break;
    }
  }
  return next;
}

export interface NearestAlarm {
  time: Date;
  tag: NoteTag;
  frequency: Frequency | null;
}

/** Get the nearest future alarm for a note, considering frequency modifiers. */
export function getNearestAlarm(note: Note, now: Date): NearestAlarm | null {
  const freqTag = note.tags.find((t) => FREQUENCIES.includes(t.tagType));
  const frequency = (freqTag?.tagType as Frequency) ?? null;

  let nearest: NearestAlarm | null = null;
  for (const tag of note.tags) {
    if (tag.tagType !== '/alarm' || !tag.tagValue) continue;
    const next = getNextOccurrence(new Date(tag.tagValue), frequency, now);
    if (next && (!nearest || next < nearest.time)) {
      nearest = { time: next, tag, frequency };
    }
  }
  return nearest;
}

/** Compute the time range bounds for filtering. */
export function getTimeRangeBounds(range: TimeRange, now: Date): [Date, Date] | null {
  if (range === 'all') return null;

  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 86400000 - 1);

  switch (range) {
    case 'today':
      return [startOfDay, endOfDay];
    case 'week': {
      const dayOfWeek = now.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(startOfDay);
      monday.setDate(monday.getDate() + mondayOffset);
      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 6);
      sunday.setHours(23, 59, 59, 999);
      return [monday, sunday];
    }
    case 'month': {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      return [firstDay, lastDay];
    }
    case '7d':
      return [now, new Date(now.getTime() + 7 * 86400000)];
    case '30d':
      return [now, new Date(now.getTime() + 30 * 86400000)];
  }
}

/** Filter and sort notes by their nearest future alarm within a time range. */
export function filterAndSortReminders(
  notes: Note[],
  timeRange: TimeRange,
  now: Date,
): { note: Note; nearest: NearestAlarm }[] {
  const bounds = getTimeRangeBounds(timeRange, now);
  const results: { note: Note; nearest: NearestAlarm }[] = [];

  for (const note of notes) {
    const nearest = getNearestAlarm(note, now);
    if (!nearest) continue;
    if (bounds) {
      const [start, end] = bounds;
      if (nearest.time < start || nearest.time > end) continue;
    }
    results.push({ note, nearest });
  }

  results.sort((a, b) => a.nearest.time.getTime() - b.nearest.time.getTime());
  return results;
}
