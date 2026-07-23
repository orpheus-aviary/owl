/**
 * Step 9 (§4.2) — the mobile TagBar rides the soft keyboard: with a keyboard
 * inset it becomes `position: fixed; bottom: <inset>` and reserves its height
 * with an in-flow placeholder. Desktop / no-inset stays a normal in-flow bar.
 * (Real soft-keyboard behaviour is verified on a device at Stage 2 — see
 * useKeyboardInset; here the inset is injected.)
 */

import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const isMobileMock = vi.hoisted(() => ({ value: true }));
const insetMock = vi.hoisted(() => ({ value: 0 }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => isMobileMock.value }));
vi.mock('@/hooks/useKeyboardInset', () => ({ useKeyboardInset: () => insetMock.value }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  listTags: vi.fn(async () => ({ success: true, data: [] })),
}));
vi.mock('@/components/DateTimePicker', () => ({ DateTimePicker: () => null }));

// jsdom has no ResizeObserver — the floating branch observes the bar to size its
// placeholder. A no-op stub is enough (offsetHeight is 0 in jsdom anyway).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

import { TagBar } from './TagBar';

beforeEach(() => {
  isMobileMock.value = true;
  insetMock.value = 0;
});

describe('TagBar — floating above the keyboard', () => {
  it('is a normal in-flow bar when there is no keyboard inset', () => {
    const { container } = render(<TagBar tags={[]} onTagsChange={vi.fn()} />);
    expect(container.querySelector('.fixed')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('floats at bottom:<inset> with an in-flow placeholder when the keyboard is up', () => {
    insetMock.value = 240;
    const { container } = render(<TagBar tags={[]} onTagsChange={vi.fn()} />);
    const bar = container.querySelector('.fixed') as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(bar?.style.bottom).toBe('240px');
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('stays in-flow on desktop even if an inset is somehow present', () => {
    isMobileMock.value = false;
    insetMock.value = 240;
    const { container } = render(<TagBar tags={[]} onTagsChange={vi.fn()} />);
    expect(container.querySelector('.fixed')).toBeNull();
  });
});
