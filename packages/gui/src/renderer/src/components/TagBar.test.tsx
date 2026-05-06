import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoteTag, Tag } from '@/lib/api';

// Mock api BEFORE importing TagBar so the mock is in place when TagBar's
// imports resolve.
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    listTags: vi.fn(),
  };
});

// DateTimePicker drags Radix Popover + Portal into jsdom, which is orthogonal
// to keybinding behavior. Minimal stub that exposes `open` state.
vi.mock('@/components/DateTimePicker', () => ({
  DateTimePicker: ({ open }: { open: boolean }) =>
    open ? <div data-testid="picker-open" /> : null,
}));

import * as api from '@/lib/api';

import { TagBar } from './TagBar';

const listTags = vi.mocked(api.listTags);

beforeEach(() => {
  vi.useFakeTimers();
  listTags.mockReset();
  listTags.mockResolvedValue({ success: true, data: [] });
});

function makeTag(value: string): Tag {
  return { id: `tag-${value}`, tagType: '#', tagValue: value };
}

// Flush the 200ms debounce + the listTags promise.
async function flushSuggestions() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

describe('TagBar — Tab/Enter', () => {
  it('T1: Tab on hashtag suggestion fills `#foo` (no trailing space), does not addTag', async () => {
    listTags.mockResolvedValue({ success: true, data: [makeTag('foo')] });
    const onTagsChange = vi.fn();
    const { getByPlaceholderText } = render(
      <TagBar tags={[] as NoteTag[]} onTagsChange={onTagsChange} />,
    );

    const input = getByPlaceholderText('输入标签...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'f' } });
    await flushSuggestions();

    fireEvent.keyDown(input, { key: 'Tab' });

    expect(input.value).toBe('#foo');
    expect(onTagsChange).not.toHaveBeenCalled();
  });

  it('T2: Tab on /time frequency fills `/time ` (trailing space), no picker, no addTag', () => {
    const onTagsChange = vi.fn();
    const { getByPlaceholderText, queryByTestId } = render(
      <TagBar tags={[]} onTagsChange={onTagsChange} />,
    );

    const input = getByPlaceholderText('输入标签...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/ti' } });
    fireEvent.keyDown(input, { key: 'Tab' });

    expect(input.value).toBe('/time ');
    expect(queryByTestId('picker-open')).toBeNull();
    expect(onTagsChange).not.toHaveBeenCalled();
  });

  it('T3: Tab on /daily fills `/daily` (no trailing space), no addTag', () => {
    const onTagsChange = vi.fn();
    const { getByPlaceholderText } = render(<TagBar tags={[]} onTagsChange={onTagsChange} />);

    const input = getByPlaceholderText('输入标签...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/da' } });
    fireEvent.keyDown(input, { key: 'Tab' });

    expect(input.value).toBe('/daily');
    expect(onTagsChange).not.toHaveBeenCalled();
  });

  it('T4: Tab with no popup does not preventDefault (default focus behavior)', () => {
    const onTagsChange = vi.fn();
    const { getByPlaceholderText } = render(<TagBar tags={[]} onTagsChange={onTagsChange} />);

    const input = getByPlaceholderText('输入标签...') as HTMLInputElement;
    // Empty input → no suggestions, no frequency popup.
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(input.value).toBe('');
    expect(onTagsChange).not.toHaveBeenCalled();
  });

  it('T5 regression: Enter on `/time` still opens the picker', () => {
    const onTagsChange = vi.fn();
    const { getByPlaceholderText, getByTestId } = render(
      <TagBar tags={[]} onTagsChange={onTagsChange} />,
    );

    const input = getByPlaceholderText('输入标签...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/time' } });
    // Frequency popup shows /time at index 0; Enter triggers picker.
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(getByTestId('picker-open')).toBeTruthy();
    expect(onTagsChange).not.toHaveBeenCalled();
  });

  it('T6 regression: ArrowDown + Enter on hashtag suggestion adds the tag', async () => {
    listTags.mockResolvedValue({
      success: true,
      data: [makeTag('foo'), makeTag('foobar')],
    });
    const onTagsChange = vi.fn();
    const { getByPlaceholderText } = render(<TagBar tags={[]} onTagsChange={onTagsChange} />);

    const input = getByPlaceholderText('输入标签...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    await flushSuggestions();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onTagsChange).toHaveBeenCalledTimes(1);
    const added = onTagsChange.mock.calls[0][0] as NoteTag[];
    expect(added).toHaveLength(1);
    expect(added[0].tagType).toBe('#');
    // ArrowDown moves from index 0 to 1 → picks 'foobar'.
    expect(added[0].tagValue).toBe('foobar');
  });
});
