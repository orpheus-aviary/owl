import { describe, expect, it } from 'vitest';
import { CliError } from './errors.js';
import { parseTagsStrict } from './tag-strict.js';

describe('parseTagsStrict', () => {
  it('normalizes bare words to hashtags', () => {
    const result = parseTagsStrict(['工作', '项目A']);
    expect(result.map((t) => ({ type: t.tagType, value: t.tagValue }))).toEqual([
      { type: '#', value: '工作' },
      { type: '#', value: '项目A' },
    ]);
  });

  it('preserves explicit hashtags and /time tags', () => {
    const result = parseTagsStrict(['#foo', '/time:2026-05-02 10:00:00']);
    expect(result).toHaveLength(2);
    expect(result[0].tagType).toBe('#');
    expect(result[0].tagValue).toBe('foo');
    expect(result[1].tagType).toBe('/time');
  });

  it('throws INVALID_TAG with details.bad when any input fails parsing', () => {
    try {
      parseTagsStrict(['good', '#', '/unknown:xx']);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const cliErr = err as CliError;
      expect(cliErr.code).toBe('INVALID_TAG');
      expect(cliErr.details?.bad).toEqual(expect.arrayContaining(['#', '/unknown:xx']));
    }
  });

  it('throws INVALID_TAG for empty / whitespace-only inputs', () => {
    expect(() => parseTagsStrict([''])).toThrow(CliError);
    expect(() => parseTagsStrict(['   '])).toThrow(CliError);
  });

  it('returns empty array for empty input list (no throw)', () => {
    expect(parseTagsStrict([])).toEqual([]);
  });
});
