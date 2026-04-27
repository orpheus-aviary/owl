import { describe, expect, it } from 'vitest';
import { isExactlyWrapped } from './MarkdownEditor';

describe('isExactlyWrapped (markdown toggle disambiguation)', () => {
  it('matches a bold-wrapped selection', () => {
    expect(isExactlyWrapped('**foo**', '**')).toBe(true);
    expect(isExactlyWrapped('** **', '**')).toBe(true); // empty inner is fine
  });

  it('matches an italic-wrapped selection without surrounding stars', () => {
    expect(isExactlyWrapped('*foo*', '*')).toBe(true);
    expect(isExactlyWrapped('* *', '*')).toBe(true);
  });

  it('does NOT treat a bold span as italic-wrapped', () => {
    // **foo** starts/ends with * but inner *foo* also starts/ends with * —
    // pressing Cmd+I should NOT strip a single * from each side.
    expect(isExactlyWrapped('**foo**', '*')).toBe(false);
  });

  it('matches inline-code wrapping', () => {
    expect(isExactlyWrapped('`foo`', '`')).toBe(true);
  });

  it('rejects too-short selections', () => {
    expect(isExactlyWrapped('*', '*')).toBe(false);
    expect(isExactlyWrapped('**', '**')).toBe(false);
    expect(isExactlyWrapped('', '*')).toBe(false);
  });

  it('rejects selections without matching markers on both ends', () => {
    expect(isExactlyWrapped('**foo', '**')).toBe(false);
    expect(isExactlyWrapped('foo**', '**')).toBe(false);
    expect(isExactlyWrapped('foo', '*')).toBe(false);
  });
});
