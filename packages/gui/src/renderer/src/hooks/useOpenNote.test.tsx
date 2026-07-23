import { useNoteNavGuard } from '@/stores/note-nav-guard';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOpenNote } from './useOpenNote';

// The mocked editor-store below spreads the REAL module (`...actual`), whose
// transitive graph reads platform.remoteClient; mock the platform so that load
// never depends on another test file having stubbed it first (cross-file order).
vi.mock('@/platform', () => ({
  getPlatform: () => ({ remoteClient: false, daemonBaseUrl: () => '' }),
}));

const isMobileMock = vi.hoisted(() => ({ value: false }));
vi.mock('./useIsMobile', () => ({ useIsMobile: () => isMobileMock.value }));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

const openNoteByIdMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/stores/editor-store', async (orig) => {
  const actual = await orig<typeof import('@/stores/editor-store')>();
  return { ...actual, openNoteById: openNoteByIdMock };
});

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter initialEntries={['/browser?q=x']}>{children}</MemoryRouter>;
}

function opener() {
  return renderHook(() => useOpenNote(), { wrapper }).result.current;
}

beforeEach(() => {
  isMobileMock.value = false;
  navigateMock.mockClear();
  openNoteByIdMock.mockClear();
  vi.restoreAllMocks();
});

describe('useOpenNote — desktop branch', () => {
  it('no prepare → openNoteById + navigate("/") → opened', async () => {
    const outcome = await opener()({ noteId: 'n1' });
    expect(openNoteByIdMock).toHaveBeenCalledWith('n1');
    expect(navigateMock).toHaveBeenCalledWith('/');
    expect(outcome).toBe('opened');
  });

  it('with prepare → runs prepare (not openNoteById) + navigate("/")', async () => {
    const prepare = vi.fn(() => 'ok' as const);
    const outcome = await opener()({ noteId: 'n1', prepare });
    expect(prepare).toHaveBeenCalledOnce();
    expect(openNoteByIdMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/');
    expect(outcome).toBe('opened');
  });

  it('openNoteById throwing → failed, no navigation', async () => {
    openNoteByIdMock.mockRejectedValueOnce(new Error('boom'));
    const outcome = await opener()({ noteId: 'n1' });
    expect(outcome).toBe('failed');
    expect(navigateMock).not.toHaveBeenCalled();
  });
});

describe('useOpenNote — mobile branch', () => {
  it('delegates to the guard with a live NavContext', async () => {
    isMobileMock.value = true;
    const openSpy = vi.spyOn(useNoteNavGuard.getState(), 'open').mockResolvedValue('opened');

    const outcome = await opener()({ noteId: 'n1' });
    expect(outcome).toBe('opened');
    expect(openSpy).toHaveBeenCalledOnce();

    const [intent, nav] = openSpy.mock.calls[0];
    expect(intent).toEqual({ noteId: 'n1' });
    // The NavContext reads the live route, not a stale closure.
    expect(nav.path()).toBe('/browser');
    expect(nav.search()).toBe('?q=x');
    // Desktop's openNoteById path is NOT taken on mobile.
    expect(openNoteByIdMock).not.toHaveBeenCalled();
  });
});
