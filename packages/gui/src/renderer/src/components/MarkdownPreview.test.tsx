import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock NoteIdPill with a minimal span so we test the MarkdownPreview
// pipeline (plugin + urlTransform + <a> override) without dragging Radix
// ContextMenu into jsdom (its React hooks don't co-operate with the pnpm
// two-copies-of-react setup and that's orthogonal to what's under test).
vi.mock('./NoteIdPill', () => ({
  NoteIdPill: ({ id }: { id: string }) => <span data-testid="note-pill" data-id={id} />,
}));

// `remoteClient` decides whether the rehype chain drops `rehypeRaw` (web) or
// keeps it (desktop). Mock the platform so each test can flip the branch;
// jsdom has no `window.owlAPI`, so the real adapter would report web anyway —
// the mock just makes it explicit and lets the desktop-regression test set it.
const platformMock = vi.hoisted(() => ({ remoteClient: true }));
vi.mock('@/platform', () => ({
  getPlatform: () => ({ remoteClient: platformMock.remoteClient }),
}));

import { MarkdownPreview } from './MarkdownPreview';

beforeEach(() => {
  vi.clearAllMocks();
  platformMock.remoteClient = true;
});

// A `window.open` spy is installed in the external-link tests; restore real
// implementations between cases so the replacement doesn't leak.
afterEach(() => {
  vi.restoreAllMocks();
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

describe('MarkdownPreview — web XSS hardening (remoteClient drops rehypeRaw)', () => {
  it('does not parse raw <script>/<img onerror> HTML into live elements', () => {
    const md = `before <img src=x onerror="alert(1)"> and <script>alert(2)</script> after`;
    const { container } = render(<MarkdownPreview content={md} />);
    // No live nodes — the raw HTML is escaped to text, so it can never run.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<img');
  });

  it('still renders KaTeX math (math nodes flow straight to rehypeKatex)', () => {
    const { container } = render(<MarkdownPreview content={'inline $x^2$ done'} />);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('still highlights fenced code blocks', () => {
    const md = '```js\nconst a = 1;\n```';
    const { container } = render(<MarkdownPreview content={md} />);
    expect(container.querySelector('code.hljs')).not.toBeNull();
  });
});

describe('MarkdownPreview — desktop keeps raw HTML (zero regression)', () => {
  it('parses raw <img> HTML into a real element when remoteClient is false', () => {
    platformMock.remoteClient = false;
    const md = `pic <img src="x.png" alt="pic"> end`;
    const { container } = render(<MarkdownPreview content={md} />);
    expect(container.querySelector('img')).not.toBeNull();
  });
});

describe('MarkdownPreview — external links', () => {
  it('renders external links with target=_blank + rel=noopener noreferrer', () => {
    const { container } = render(<MarkdownPreview content={'[x](https://example.com)'} />);
    const a = container.querySelector('a[href="https://example.com"]');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toContain('noopener');
    expect(a?.getAttribute('rel')).toContain('noreferrer');
  });

  it('does NOT set target=_blank on in-page # anchors', () => {
    const { container } = render(<MarkdownPreview content={'[jump](#sec)'} />);
    const a = container.querySelector('a[href="#sec"]');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('target')).toBeNull();
  });

  it('opens external links via window.open with noopener,noreferrer', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { container } = render(<MarkdownPreview content={'[x](https://example.com)'} />);
    const a = container.querySelector('a[href="https://example.com"]');
    (a as HTMLAnchorElement).click();
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
  });
});
