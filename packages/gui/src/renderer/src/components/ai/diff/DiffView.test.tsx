/**
 * Step 7 (mobile conflict UI, §4.5) — DiffView drops the side-by-side
 * @codemirror/merge MergeView on mobile in favour of two stacked read-only
 * panes. The key invariant: no MergeView is instantiated on mobile.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from './DiffView';

const mobileMock = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobileMock.value }));

// Spy on MergeView construction — the whole point is that mobile never builds one.
const mergeViewCtor = vi.hoisted(() => vi.fn());
vi.mock('@codemirror/merge', () => ({
  MergeView: class {
    a = { requestMeasure: vi.fn() };
    b = { requestMeasure: vi.fn(), state: { doc: { toString: () => 'DOC' } } };
    constructor(cfg: unknown) {
      mergeViewCtor(cfg);
    }
    destroy() {}
  },
}));

beforeEach(() => {
  mobileMock.value = false;
  mergeViewCtor.mockClear();
});

describe('DiffView', () => {
  it('builds a MergeView on desktop', () => {
    render(<DiffView original="AAA" modified="BBB" />);
    expect(mergeViewCtor).toHaveBeenCalledTimes(1);
  });

  it('renders stacked read-only panes on mobile without a MergeView', () => {
    mobileMock.value = true;
    render(
      <DiffView original="AAA" modified="BBB" originalLabel="本地版本" modifiedLabel="远端版本" />,
    );
    expect(mergeViewCtor).not.toHaveBeenCalled();
    expect(screen.getByText('AAA')).toBeTruthy();
    expect(screen.getByText('BBB')).toBeTruthy();
    expect(screen.getByText('本地版本')).toBeTruthy();
    expect(screen.getByText('远端版本')).toBeTruthy();
    // Read-only: no editable textbox in the fallback.
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
