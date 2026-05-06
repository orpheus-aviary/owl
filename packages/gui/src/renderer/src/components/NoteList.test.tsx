import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// api.listNotes fires inside NoteList's mount effect. Stub it so we can
// drive the note list from test-controlled fixtures rather than real HTTP.
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    listNotes: vi.fn(),
    pinNote: vi.fn(),
  };
});

// DeleteConfirmDialog's `useRequestDeleteNote` calls `useNavigate`, which
// would require a Router wrapper — and a Router wrapper trips React 19's
// duplicate-instance hook check under vitest even with dedupe/aliases.
// The component under test doesn't exercise the delete flow, so short-
// circuit the hook to a noop callable and keep the tree React-pure.
vi.mock('@/components/DeleteConfirmDialog', () => ({
  useRequestDeleteNote: () => () => Promise.resolve(),
}));

// useNoteStore goes through zustand's react binding, which under pnpm
// resolves zustand to its own `react` copy and trips the "Cannot read
// properties of null (reading 'useCallback')" React 19 dup-instance check.
// We don't need the real store for these tests — a stub hook returning a
// fixed `notes` array fully models NoteList's consumption.
const mockNotes: { value: Note[] } = { value: [] };
vi.mock('@/stores/note-store', () => ({
  useNoteStore: () => ({
    notes: mockNotes.value,
    query: '',
    loading: false,
    fetchNotes: vi.fn(() => Promise.resolve()),
    setQuery: vi.fn(),
    createNote: vi.fn(() => Promise.resolve(null)),
  }),
}));

// data-bus subscription happens inside several stores; the NoteList itself
// only reads it for pin toggling, so the `getState().bumpNotes()` call can
// land on a stub.
vi.mock('@/stores/data-bus', () => ({
  useDataBus: {
    getState: () => ({ bumpNotes: vi.fn() }),
  },
}));

// Radix ScrollArea / ContextMenu primitives resolve their own React copy
// under pnpm → dup-instance tripwire. Render them as pass-throughs; the
// tests assert on click/keyboard callbacks, not DOM structure.
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: () => null,
  ContextMenuItem: () => null,
}));

// NoteListItem pulls in @dnd-kit (React hooks → dup-instance tripwire) and
// TagDisplay (Radix portals). Both are orthogonal to what we're testing —
// swap in a minimal row that surfaces just the props NoteList cares about
// (`onClick` / `onDoubleClick`) so the callback assertions run without
// pulling the whole render subtree in.
vi.mock('@/components/NoteListItem', () => ({
  NoteListItem: ({
    note,
    onClick,
    onDoubleClick,
    tabIndex,
  }: {
    note: { id: string; content: string };
    onClick: () => void;
    onDoubleClick?: () => void;
    tabIndex?: number;
  }) => (
    <button
      type="button"
      data-testid={`row-${note.id}`}
      tabIndex={tabIndex}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {note.content}
    </button>
  ),
}));

import { NoteList } from './NoteList';

const listNotes = vi.mocked(api.listNotes);

function makeNote(id: string, content: string): Note {
  return {
    id,
    content,
    tags: [],
    folderId: null,
    trashLevel: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    trashedAt: null,
    autoDeleteAt: null,
    deviceId: null,
    contentHash: null,
    pinnedAt: null,
    position: null,
  };
}

const NOTES: Note[] = [
  makeNote('n1', '# First'),
  makeNote('n2', '# Second'),
  makeNote('n3', '# Third'),
];

async function flushEffects() {
  // Let the mount-time fetchNotes + any state updates settle.
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  listNotes.mockReset();
  listNotes.mockResolvedValue({ success: true, data: NOTES, total: NOTES.length });
  mockNotes.value = NOTES;
  // jsdom has no layout → no scrollIntoView. The arrow-key path calls it;
  // shim to a noop so the handler doesn't throw mid-click.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

function renderList(onSelectNote: (note: Note, opts?: { preview?: boolean }) => void) {
  return render(<NoteList activeNoteId={null} onSelectNote={onSelectNote} />);
}

describe('NoteList — preview/pinned interactions (P3.4-e)', () => {
  it('single-click → onSelectNote called with {preview:true} and the full Note', async () => {
    const onSelectNote = vi.fn();
    const { getByTestId } = renderList(onSelectNote);
    await flushEffects();

    fireEvent.click(getByTestId('row-n1'));

    expect(onSelectNote).toHaveBeenCalledTimes(1);
    const [note, opts] = onSelectNote.mock.calls[0]!;
    expect(note.id).toBe('n1');
    expect(opts).toEqual({ preview: true });
  });

  it('double-click → onSelectNote called with {preview:false}', async () => {
    const onSelectNote = vi.fn();
    const { getByTestId } = renderList(onSelectNote);
    await flushEffects();

    const target = getByTestId('row-n2');
    // A real double-click fires two `click` events then a `dblclick`. The
    // relevant assertion is that dblclick lands with preview:false; the
    // trailing preview:true from the prior click is also fine (tested elsewhere).
    fireEvent.click(target);
    fireEvent.click(target);
    fireEvent.doubleClick(target);

    const pinnedCalls = onSelectNote.mock.calls.filter(([, opts]) => opts?.preview === false);
    expect(pinnedCalls.length).toBeGreaterThanOrEqual(1);
    expect(pinnedCalls[0]?.[0]?.id).toBe('n2');
  });

  it('ArrowDown on the list container seeds index 0 with {preview:true}', async () => {
    const onSelectNote = vi.fn();
    const { container } = renderList(onSelectNote);
    await flushEffects();

    const listContainer = container.querySelector('[tabindex="0"]') as HTMLElement;
    expect(listContainer).toBeTruthy();
    fireEvent.keyDown(listContainer, { key: 'ArrowDown' });

    expect(onSelectNote).toHaveBeenCalledTimes(1);
    const [note, opts] = onSelectNote.mock.calls[0]!;
    expect(note.id).toBe('n1');
    expect(opts).toEqual({ preview: true });
  });

  it('ArrowDown twice then ArrowUp walks the list', async () => {
    const onSelectNote = vi.fn();
    const { container } = renderList(onSelectNote);
    await flushEffects();

    const listContainer = container.querySelector('[tabindex="0"]') as HTMLElement;
    fireEvent.keyDown(listContainer, { key: 'ArrowDown' }); // n1
    fireEvent.keyDown(listContainer, { key: 'ArrowDown' }); // n2
    fireEvent.keyDown(listContainer, { key: 'ArrowUp' }); // back to n1

    expect(onSelectNote).toHaveBeenCalledTimes(3);
    expect(onSelectNote.mock.calls[0]![0]!.id).toBe('n1');
    expect(onSelectNote.mock.calls[1]![0]!.id).toBe('n2');
    expect(onSelectNote.mock.calls[2]![0]!.id).toBe('n1');
    for (const [, opts] of onSelectNote.mock.calls) {
      expect(opts).toEqual({ preview: true });
    }
  });

  it('ArrowDown fired from the search input does NOT trigger onSelectNote', async () => {
    const onSelectNote = vi.fn();
    const { getByPlaceholderText } = renderList(onSelectNote);
    await flushEffects();

    const input = getByPlaceholderText('搜索笔记...') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    expect(onSelectNote).not.toHaveBeenCalled();
  });
});
