import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorPage } from './EditorPage';

// isMobile is host+viewport driven; flip it per test.
const isMobileMock = vi.hoisted(() => ({ value: true }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => isMobileMock.value }));

// The detail effect awaits `resolveOpen`; drive its outcome directly.
const resolveOpenMock = vi.hoisted(() => vi.fn());
vi.mock('@/stores/editor-store', async (orig) => {
  const actual = await orig<typeof import('@/stores/editor-store')>();
  return { ...actual, resolveOpen: resolveOpenMock };
});

// Master routes selections through the opener; spy on it.
const openNoteMock = vi.hoisted(() => vi.fn(async () => 'opened' as const));
vi.mock('@/hooks/useOpenNote', () => ({ useOpenNote: () => openNoteMock }));

// Stub the heavy leaves so the page renders in jsdom without CodeMirror /
// resizable panels / shortcuts side effects.
vi.mock('@/components/EditorPanel', () => ({
  EditorPanel: () => <div data-testid="editor-panel" />,
}));
vi.mock('@/components/NoteList', () => ({
  NoteList: ({ onSelectNote }: { onSelectNote: (n: { id: string }) => void }) => (
    <button type="button" data-testid="note-item" onClick={() => onSelectNote({ id: 'n1' })}>
      note
    </button>
  ),
}));
vi.mock('@/components/TabBar', () => ({ TabBar: () => <div data-testid="tab-bar" /> }));
vi.mock('@/components/ui/resize-handle', () => ({ ResizeHandle: () => <div /> }));
vi.mock('@/hooks/useEditorShortcuts', () => ({ useEditorShortcuts: () => {} }));
vi.mock('@/hooks/useOwlLayout', () => ({
  useOwlLayout: () => ({ defaultLayout: undefined, onLayoutChanged: () => {} }),
}));
vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<EditorPage />} />
        <Route path="/note/:noteId" element={<EditorPage />} />
        <Route path="/browser" element={<div data-testid="browse" />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  isMobileMock.value = true;
  resolveOpenMock.mockReset();
  openNoteMock.mockClear();
});

describe('EditorPage — mobile detail (/note/:id)', () => {
  it('opened → renders the editor panel', async () => {
    resolveOpenMock.mockResolvedValue({ kind: 'opened' });
    renderAt('/note/n1');
    expect(await screen.findByTestId('editor-panel')).toBeTruthy();
    expect(resolveOpenMock).toHaveBeenCalledWith('n1');
  });

  it('not-found → empty state, no panel', async () => {
    resolveOpenMock.mockResolvedValue({ kind: 'not-found' });
    renderAt('/note/gone');
    expect(await screen.findByText(/不存在或已被删除/)).toBeTruthy();
    expect(screen.queryByTestId('editor-panel')).toBeNull();
  });

  it('load-failed → 重试 re-runs the resolve', async () => {
    resolveOpenMock
      .mockResolvedValueOnce({ kind: 'load-failed' })
      .mockResolvedValueOnce({ kind: 'opened' });
    renderAt('/note/n1');
    const retry = await screen.findByRole('button', { name: '重试' });
    expect(resolveOpenMock).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    expect(await screen.findByTestId('editor-panel')).toBeTruthy();
    expect(resolveOpenMock).toHaveBeenCalledTimes(2);
  });

  it('aliased → canonical-replace to the real id', async () => {
    resolveOpenMock
      .mockResolvedValueOnce({ kind: 'aliased', realId: 'real1' })
      .mockResolvedValue({ kind: 'opened' });
    renderAt('/note/draft_x');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/note/real1'));
    // The re-resolve for the real id runs after the replace.
    expect(resolveOpenMock).toHaveBeenCalledWith('real1');
  });
});

describe('EditorPage — mobile bare / (no editor home)', () => {
  it('redirects / → /browser and never resolves a detail', async () => {
    isMobileMock.value = true;
    renderAt('/');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/browser'));
    expect(screen.queryByTestId('note-item')).toBeNull();
    expect(resolveOpenMock).not.toHaveBeenCalled();
  });
});

describe('EditorPage — desktop passthrough', () => {
  it('ignores the /note/:id param and never runs the detail resolve', async () => {
    isMobileMock.value = false;
    renderAt('/note/n1');
    // Desktop renders the tabbed editor (panel + tab bar), not a detail resolve.
    expect(await screen.findByTestId('tab-bar')).toBeTruthy();
    expect(resolveOpenMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/加载中/)).toBeNull();
  });
});
