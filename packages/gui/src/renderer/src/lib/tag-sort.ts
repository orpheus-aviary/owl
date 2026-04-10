import type { NoteTag } from './api';

/**
 * Unified tag sort order across all pages:
 * 1. # hashtags — sorted by pinyin (zh-CN locale)
 * 2. /alarm — sorted by time ascending
 * 3. /time — sorted by time ascending
 * 4. Frequency tags (/daily, /weekly, /monthly, /yearly)
 */

const TAG_TYPE_ORDER: Record<string, number> = {
  '#': 0,
  '/alarm': 1,
  '/time': 2,
  '/daily': 3,
  '/weekly': 4,
  '/monthly': 5,
  '/yearly': 6,
};

export function sortTags(tags: NoteTag[]): NoteTag[] {
  return [...tags].sort((a, b) => {
    const oa = TAG_TYPE_ORDER[a.tagType] ?? 9;
    const ob = TAG_TYPE_ORDER[b.tagType] ?? 9;
    if (oa !== ob) return oa - ob;

    // Same type group — secondary sort
    if (a.tagType === '#') {
      // Pinyin sort for Chinese characters
      return (a.tagValue ?? '').localeCompare(b.tagValue ?? '', 'zh-CN');
    }
    if (a.tagType === '/alarm' || a.tagType === '/time') {
      // Time ascending
      return (a.tagValue ?? '').localeCompare(b.tagValue ?? '');
    }
    return 0;
  });
}
