import type { Note } from '@/lib/api';
import { useEditorStore } from '@/stores/editor-store';
import type { TabState } from '@/stores/editor-store';
import { type NavState, useNoteNavGuard } from '@/stores/note-nav-guard';
import { useNoteStore } from '@/stores/note-store';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileTopBar } from './MobileTopBar';

// editor-store transitively reads platform.remoteClient; a minimal mock keeps
// the import off the real adapter.
vi.mock('@/platform', () => ({
  getPlatform: () => ({ remoteClient: false, daemonBaseUrl: () => '' }),
}));

// The 新建笔记 button opens the fresh note through the opener; spy on it.
const openNoteSpy = vi.hoisted(() => vi.fn(async () => 'opened' as const));
vi.mock('@/hooks/useOpenNote', () => ({ useOpenNote: () => openNoteSpy }));

function tab(noteId: string, opts?: Partial<TabState>): TabState {
  return {
    noteId,
    title: noteId,
    content: '',
    originalContent: '',
    tags: [],
    originalTags: [],
    folderId: null,
    originalFolderId: null,
    originalUpdatedAt: '',
    dirty: false,
    isDraft: false,
    pendingAiUpdate: null,
    preview: false,
    remoteUpdated: false,
    ...opts,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderDetailBarAt(path: string, state?: NavState) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <Routes>
        <Route path="*" element={<MobileTopBar />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useEditorStore.setState({ tabs: [], activeTabId: null });
  useNoteNavGuard.getState().reset();
  vi.restoreAllMocks();
  openNoteSpy.mockClear();
});

describe('MobileTopBar — detail save-return race (§4.1.6 a)', () => {
  it('draft→real save canonical-replaces the URL to the real id', async () => {
    useEditorStore.setState({
      tabs: [tab('draft_x', { isDraft: true, dirty: true, title: 'Draft' })],
      activeTabId: 'draft_x',
    });
    vi.spyOn(useEditorStore.getState(), 'requestSaveOrConflict').mockResolvedValue({
      status: 'saved',
      ok: true,
      noteId: 'real1',
    });

    renderDetailBarAt('/note/draft_x');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/note/real1'));
  });

  it('same-id save does NOT navigate (URL already correct)', async () => {
    useEditorStore.setState({
      tabs: [tab('real1', { dirty: true, title: 'Note' })],
      activeTabId: 'real1',
    });
    const spy = vi.spyOn(useEditorStore.getState(), 'requestSaveOrConflict').mockResolvedValue({
      status: 'saved',
      ok: true,
      noteId: 'real1',
    });

    renderDetailBarAt('/note/real1');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.getByTestId('loc').textContent).toBe('/note/real1');
  });

  it('a conflict save (ok:false) leaves the URL alone', async () => {
    useEditorStore.setState({
      tabs: [tab('draft_x', { isDraft: true, dirty: true, title: 'Draft' })],
      activeTabId: 'draft_x',
    });
    vi.spyOn(useEditorStore.getState(), 'requestSaveOrConflict').mockResolvedValue({
      status: 'conflict',
      ok: false,
      noteId: 'draft_x',
    });

    renderDetailBarAt('/note/draft_x');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    // Give the awaited save a tick; the route must stay on the draft.
    await Promise.resolve();
    expect(screen.getByTestId('loc').textContent).toBe('/note/draft_x');
  });

  it('返回 with a clean note leaves immediately (guard fast-path)', () => {
    useEditorStore.setState({
      tabs: [tab('real1', { title: 'Note' })], // clean
      activeTabId: 'real1',
    });
    renderDetailBarAt('/note/real1', { appNavigation: true, canPop: false, returnTo: '/browser' });
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(screen.getByTestId('loc').textContent).toBe('/browser');
    expect(useNoteNavGuard.getState().prompt).toBeNull();
  });

  it('返回 with a dirty note opens the guard prompt instead of leaving', () => {
    useEditorStore.setState({
      tabs: [tab('real1', { dirty: true, title: 'Note' })],
      activeTabId: 'real1',
    });
    renderDetailBarAt('/note/real1', { appNavigation: true, canPop: false, returnTo: '/browser' });
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    expect(useNoteNavGuard.getState().prompt).toEqual({
      title: 'Note',
      phase: 'prompting',
      kind: 'leave',
    });
    expect(screen.getByTestId('loc').textContent).toBe('/note/real1'); // stayed
  });
});

describe('MobileTopBar — 新建笔记 button', () => {
  it('appears on the listing pages and creates + opens a note', async () => {
    const created = { id: 'new1' } as unknown as Note;
    const createSpy = vi.spyOn(useNoteStore.getState(), 'createNote').mockResolvedValue(created);
    renderDetailBarAt('/browser');
    fireEvent.click(screen.getByRole('button', { name: '新建笔记' }));
    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(openNoteSpy).toHaveBeenCalledWith({ noteId: 'new1' });
  });

  it('also appears on the 文件 page', () => {
    renderDetailBarAt('/files');
    expect(screen.getByRole('button', { name: '新建笔记' })).toBeTruthy();
  });

  it('is hidden on read-only listing pages and the detail route', () => {
    renderDetailBarAt('/reminders');
    expect(screen.queryByRole('button', { name: '新建笔记' })).toBeNull();
  });
});
