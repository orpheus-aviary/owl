/**
 * Step 8 (touch polish, §5) — the files-page (touch) variant carries a dedicated
 * grip so 按住拖动整理 coexists with tap-to-open + the long-press menu. The grip
 * is gated on `variant !== 'sidebar'`; desktop drags the whole row (no grip).
 */

import type { Folder, Note } from '@/lib/api';
import { useFolderStore } from '@/stores/folder-store';
import { DndContext } from '@dnd-kit/core';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderPanel } from './FolderPanel';

vi.mock('@/platform', () => ({
  getPlatform: () => ({ remoteClient: false, daemonBaseUrl: () => '' }),
}));
vi.mock('@/hooks/useOpenNote', () => ({ useOpenNote: () => vi.fn(async () => 'opened') }));
vi.mock('@/components/DeleteConfirmDialog', () => ({ useRequestDeleteNote: () => vi.fn() }));

function makeFolder(over: Partial<Folder> = {}): Folder {
  return {
    id: 'f1',
    name: 'Folder 1',
    parent_id: null,
    position: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    device_id: null,
    ...over,
  };
}

function makeNote(over: Partial<Note> = {}): Note {
  return {
    id: 'n1',
    content: '# Note 1',
    folderId: 'f1',
    trashLevel: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    trashedAt: null,
    autoDeleteAt: null,
    deviceId: null,
    contentHash: null,
    pinnedAt: null,
    position: null,
    tags: [],
    ...over,
  };
}

function renderPanel(variant: 'sidebar' | 'page') {
  return render(
    <MemoryRouter>
      <DndContext>
        <FolderPanel variant={variant} />
      </DndContext>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // One folder with one note inside it, expanded so the note row renders too.
  useFolderStore.setState({
    folders: [makeFolder()],
    panelNotes: [makeNote()],
    expanded: new Set(['f1']),
    loading: false,
    error: null,
  });
});

describe('FolderPanel drag handle', () => {
  it('renders grips for folder + note rows on the page (touch) variant', () => {
    renderPanel('page');
    const grips = screen.getAllByRole('button', { name: '拖动排序' });
    expect(grips.length).toBeGreaterThanOrEqual(2); // folder row + note row
    expect(grips[0].className).toContain('touch-none'); // won't scroll while dragging
  });

  it('renders no grip on the desktop sidebar variant', () => {
    renderPanel('sidebar');
    expect(screen.queryByRole('button', { name: '拖动排序' })).toBeNull();
  });
});
