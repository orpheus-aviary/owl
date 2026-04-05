import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractTagsFromContent, inferDateTime, parseTag, parseTags } from './parser.js';

describe('parseTag', () => {
  it('parses hashtags', () => {
    const result = parseTag('#工作');
    assert.deepEqual(result, { tagType: '#', tagValue: '工作' });
  });

  it('rejects empty hashtag', () => {
    assert.equal(parseTag('#'), null);
    assert.equal(parseTag('# '), null);
  });

  it('parses frequency modifiers', () => {
    assert.deepEqual(parseTag('/daily'), { tagType: '/daily', tagValue: '' });
    assert.deepEqual(parseTag('/weekly'), { tagType: '/weekly', tagValue: '' });
    assert.deepEqual(parseTag('/monthly'), { tagType: '/monthly', tagValue: '' });
    assert.deepEqual(parseTag('/yearly'), { tagType: '/yearly', tagValue: '' });
  });

  it('parses /time with full datetime', () => {
    const result = parseTag('/time 2026-04-10 14:30:00');
    assert.ok(result);
    assert.equal(result.tagType, '/time');
    assert.equal(result.tagValue, '2026-04-10T14:30:00');
  });

  it('parses /alarm with date and time', () => {
    const result = parseTag('/alarm 2026-12-25 09:00');
    assert.ok(result);
    assert.equal(result.tagType, '/alarm');
    assert.equal(result.tagValue, '2026-12-25T09:00:00');
  });

  it('parses /time without value', () => {
    const result = parseTag('/time');
    assert.deepEqual(result, { tagType: '/time', tagValue: '' });
  });

  it('parses /time: colon format', () => {
    const result = parseTag('/time:2026-04-07 15:00');
    assert.ok(result);
    assert.equal(result.tagType, '/time');
    assert.equal(result.tagValue, '2026-04-07T15:00:00');
  });

  it('parses /alarm: colon format', () => {
    const result = parseTag('/alarm:2026-12-25 09:00');
    assert.ok(result);
    assert.equal(result.tagType, '/alarm');
    assert.equal(result.tagValue, '2026-12-25T09:00:00');
  });

  it('returns null for empty input', () => {
    assert.equal(parseTag(''), null);
    assert.equal(parseTag('  '), null);
  });

  it('returns null for unknown format', () => {
    assert.equal(parseTag('random text'), null);
  });
});

describe('parseTags', () => {
  it('parses multiple tags', () => {
    const results = parseTags(['#工作', '#学习', '/daily']);
    assert.equal(results.length, 3);
    assert.equal(results[0].tagType, '#');
    assert.equal(results[2].tagType, '/daily');
  });

  it('skips invalid tags', () => {
    const results = parseTags(['#valid', 'invalid', '#']);
    assert.equal(results.length, 1);
  });
});

describe('extractTagsFromContent', () => {
  it('extracts hashtags from content', () => {
    const tags = extractTagsFromContent('Hello #工作 world #学习');
    assert.deepEqual(tags, ['#工作', '#学习']);
  });

  it('extracts /time tags', () => {
    const tags = extractTagsFromContent('Meeting /time 2026-04-07 15:00');
    assert.equal(tags.length, 1);
    assert.equal(tags[0], '/time 2026-04-07 15:00');
  });

  it('extracts /alarm tags', () => {
    const tags = extractTagsFromContent('Reminder /alarm 2026-04-07 15:00 #工作');
    assert.ok(tags.includes('#工作'));
    assert.ok(tags.some((t) => t.startsWith('/alarm')));
  });

  it('extracts frequency modifiers', () => {
    const tags = extractTagsFromContent('Daily check /daily #routine');
    assert.ok(tags.includes('/daily'));
    assert.ok(tags.includes('#routine'));
  });

  it('returns empty for content without tags', () => {
    const tags = extractTagsFromContent('Just plain text');
    assert.equal(tags.length, 0);
  });

  it('handles hashtag at start of line', () => {
    const tags = extractTagsFromContent('#日记\nSome text');
    assert.deepEqual(tags, ['#日记']);
  });
});

describe('inferDateTime', () => {
  it('parses full YYYY-MM-DD HH:MM:SS', () => {
    assert.equal(inferDateTime('2026-04-10 14:30:45'), '2026-04-10T14:30:45');
  });

  it('parses YYYY-MM-DD HH:MM (seconds default 0)', () => {
    assert.equal(inferDateTime('2026-04-10 14:30'), '2026-04-10T14:30:00');
  });

  it('parses YYYY-MM-DD (time defaults to 23:59:59)', () => {
    assert.equal(inferDateTime('2026-04-10'), '2026-04-10T23:59:59');
  });

  it('parses YY-MM-DD with 20xx prefix', () => {
    assert.equal(inferDateTime('26-04-10 14:30'), '2026-04-10T14:30:00');
  });

  it('parses ISO 8601 with T separator', () => {
    assert.equal(inferDateTime('2026-04-07T15:00'), '2026-04-07T15:00:00');
    assert.equal(inferDateTime('2026-04-07T15:00:30'), '2026-04-07T15:00:30');
  });

  it('returns null for invalid input', () => {
    assert.equal(inferDateTime(''), null);
    assert.equal(inferDateTime('abc'), null);
    assert.equal(inferDateTime('not-a-date'), null);
  });
});
