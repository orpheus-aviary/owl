import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inferDateTime, parseTag, parseTags } from './parser.js';

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

  it('returns null for invalid input', () => {
    assert.equal(inferDateTime(''), null);
    assert.equal(inferDateTime('abc'), null);
    assert.equal(inferDateTime('not-a-date'), null);
  });
});
