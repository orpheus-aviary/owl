import { useDataBus } from '@/stores/data-bus';
import { useEditorStore } from '@/stores/editor-store';
import type { TabState } from '@/stores/editor-tabs';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/platform', () => ({
  getPlatform: () => ({ remoteClient: false, daemonBaseUrl: () => '' }),
}));

// delete-by-source opens the dirty note through the opener; spy on it. The
// return type is widened so tests can resolve a 'cancelled' outcome.
const openNoteSpy = vi.hoisted(() =>
  vi.fn(async (): Promise<'opened' | 'cancelled' | 'failed'> => 'opened'),
);
vi.mock('@/hooks/useOpenNote', () => ({ useOpenNote: () => openNoteSpy }));

const deleteNoteMock = vi.hoisted(() => vi.fn(async () => ({ success: true, data: undefined })));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  deleteNote: deleteNoteMock,
}));

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateMock };
});

import {
  DeleteConfirmDialog,
  usePendingDeleteStore,
  useRequestDeleteNote,
} from './DeleteConfirmDialog';

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

function wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}
const requester = () => renderHook(() => useRequestDeleteNote(), { wrapper }).result.current;

beforeEach(() => {
  vi.clearAllMocks();
  openNoteSpy.mockResolvedValue('opened');
  useEditorStore.setState({ tabs: [], activeTabId: null });
  usePendingDeleteStore.getState().reset();
  vi.spyOn(useDataBus.getState(), 'bumpNotes').mockImplementation(() => {});
});

describe('useRequestDeleteNote — delete by source (§4.1.4)', () => {
  it('clean note → deletes in place, no open, no dialog', async () => {
    await requester()('n-clean');
    expect(deleteNoteMock).toHaveBeenCalledWith('n-clean');
    expect(openNoteSpy).not.toHaveBeenCalled();
    expect(usePendingDeleteStore.getState().noteId).toBeNull();
  });

  it('dirty note → opens it, then shows the confirm dialog (no delete yet)', async () => {
    useEditorStore.setState({ tabs: [tab('n1', { dirty: true })], activeTabId: 'n1' });
    await requester()('n1');
    expect(openNoteSpy).toHaveBeenCalledWith({ noteId: 'n1' });
    expect(deleteNoteMock).not.toHaveBeenCalled();
    expect(usePendingDeleteStore.getState().noteId).toBe('n1');
  });

  it('dirty note but open cancelled → no confirm dialog', async () => {
    openNoteSpy.mockResolvedValue('cancelled');
    useEditorStore.setState({ tabs: [tab('n1', { dirty: true })], activeTabId: 'n1' });
    await requester()('n1');
    expect(openNoteSpy).toHaveBeenCalledWith({ noteId: 'n1' });
    expect(usePendingDeleteStore.getState().noteId).toBeNull();
  });
});

describe('DeleteConfirmDialog — confirm', () => {
  it('deletes then replaces to / (leave the deleted note detail)', async () => {
    usePendingDeleteStore.getState().open('n1', 'My Note');
    render(<DeleteConfirmDialog />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: '放弃修改并删除' }));
    // navigate is the last step of the async onConfirm — wait for it.
    await vi.waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/', { replace: true }));
    expect(deleteNoteMock).toHaveBeenCalledWith('n1');
  });
});
