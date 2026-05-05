import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock NoteIdPill with a minimal span so we test the MarkdownPreview
// pipeline (plugin + urlTransform + <a> override) without dragging Radix
// ContextMenu into jsdom (its React hooks don't co-operate with the pnpm
// two-copies-of-react setup and that's orthogonal to what's under test).
vi.mock('./NoteIdPill', () => ({
  NoteIdPill: ({ id }: { id: string }) => <span data-testid="note-pill" data-id={id} />,
}));

import { MarkdownPreview } from './MarkdownPreview';

beforeEach(() => {
  vi.clearAllMocks();
});

const UUID = '11111111-2222-3333-4444-555555555555';

describe('MarkdownPreview — linkifyNoteIds', () => {
  it('renders a bare UUID as a pill (regression: react-markdown defaultUrlTransform stripped `note:` href)', () => {
    const { container, getByTestId } = render(
      <MarkdownPreview content={`hello ${UUID} world`} linkifyNoteIds />,
    );
    // Pill appears — plugin + urlTransform + <a> override all wired up.
    const pill = getByTestId('note-pill');
    expect(pill.getAttribute('data-id')).toBe(UUID);
    // No raw <a> with the UUID as its text (that would mean the default
    // link path was taken after the `note:` scheme was stripped).
    const anchors = container.querySelectorAll('a');
    for (const a of anchors) {
      expect(a.textContent).not.toBe(UUID);
    }
  });

  it('leaves bare UUIDs as plain text when linkifyNoteIds is off', () => {
    const { container, queryByTestId } = render(
      <MarkdownPreview content={`hello ${UUID} world`} />,
    );
    expect(queryByTestId('note-pill')).toBeNull();
    expect(container.textContent).toContain(UUID);
  });

  it('pill-ifies a UUID wrapped in single backticks (AI emphasis pattern)', () => {
    const md = `id: \`${UUID}\``;
    const { getByTestId } = render(<MarkdownPreview content={md} linkifyNoteIds />);
    expect(getByTestId('note-pill').getAttribute('data-id')).toBe(UUID);
  });

  it('does NOT pill-ify UUIDs inside fenced code blocks', () => {
    const md = `\`\`\`\nid = ${UUID}\n\`\`\``;
    const { queryByTestId, container } = render(<MarkdownPreview content={md} linkifyNoteIds />);
    expect(queryByTestId('note-pill')).toBeNull();
    expect(container.textContent).toContain(UUID);
  });
});
