import type { ConflictRecord, Note } from '@/lib/api';
import { useConflictsStore } from '@/stores/conflicts-store';
import { useEditorStore } from '@/stores/editor-store';
import type { TabState } from '@/stores/editor-tabs';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictRow, ConflictsPage } from './ConflictsPage';

vi.mock('@/stores/editor-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/editor-store')>()),
  openNoteById: vi.fn(),
}));

// Keep ApiError (used by instanceof mapping) real; stub the request wrappers.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getNote: vi.fn(),
  resolveConflict: vi.fn(),
  listConflicts: vi.fn(),
  getConflictCount: vi.fn(),
  ignoreConflict: vi.fn(),
}));

import { openNoteById } from '@/stores/editor-store';

import {
  getConflictCount,
  getNote,
  ignoreConflict,
  listConflicts,
  resolveConflict,
} from '@/lib/api';

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  useConflictsStore.setState({ list: [], count: 0, loading: false, error: null });
  useEditorStore.setState({ tabs: [], activeTabId: null });
});

function makeRow(over: Partial<ConflictRecord> = {}): ConflictRecord {
  return {
    id: 'c1',
    entity_type: 'note',
    entity_id: 'note-abcdef1234',
    local_seq: null,
    remote_seq: 1,
    detected_at: 3000,
    resolved_at: null,
    resolution: null,
    losing_side: 'local',
    local_payload: JSON.stringify({ content: 'my local text' }),
    remote_payload: JSON.stringify({ content: 'remote text' }),
    local_updated_at_ms: 1000,
    remote_updated_at_ms: 2000,
    ...over,
  };
}

function makeNote(over: Partial<Note> = {}): Note {
  return {
    id: 'note-abcdef1234',
    content: 'remote text',
    folderId: null,
    trashLevel: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-02T12:00:00.000Z',
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

function makeTab(over: Partial<TabState> = {}): TabState {
  return {
    noteId: 'note-abcdef1234',
    title: 't',
    content: 'c',
    originalContent: 'c',
    tags: [],
    originalTags: [],
    folderId: null,
    originalFolderId: null,
    originalUpdatedAt: '2026-02-02T12:00:00.000Z',
    dirty: false,
    isDraft: false,
    pendingAiUpdate: null,
    preview: false,
    ...over,
  };
}

function renderRow(
  row: ConflictRecord,
  handlers: {
    onIgnore?: (id: string) => void;
    onResolveLocal?: (row: ConflictRecord) => void;
    onOpenMerge?: (row: ConflictRecord) => void;
  } = {},
) {
  return render(
    <MemoryRouter>
      <ConflictRow
        row={row}
        onIgnore={handlers.onIgnore ?? vi.fn()}
        onResolveLocal={handlers.onResolveLocal ?? vi.fn()}
        onOpenMerge={handlers.onOpenMerge ?? vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('ConflictRow copy button (Feature A — 复制输方内容)', () => {
  it('copies the local (losing) content and flips to 已复制', async () => {
    renderRow(makeRow());
    fireEvent.click(screen.getByRole('button', { name: /复制/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('my local text'));
    expect(await screen.findByText(/已复制/)).toBeTruthy();
  });

  it('hides the copy button when there is no local payload', () => {
    renderRow(makeRow({ local_payload: null }));
    expect(screen.queryByRole('button', { name: /复制/ })).toBeNull();
  });
});

describe('ConflictRow 打开笔记', () => {
  it('opens the conflicting note in the editor by entity_id', () => {
    renderRow(makeRow({ entity_id: 'note-xyz-123' }));
    fireEvent.click(screen.getByRole('button', { name: /打开笔记/ }));
    expect(openNoteById).toHaveBeenCalledWith('note-xyz-123');
  });
});

describe('ConflictRow W7 resolve entries', () => {
  it('用本地覆盖 calls onResolveLocal with the row', () => {
    const onResolveLocal = vi.fn();
    renderRow(makeRow(), { onResolveLocal });
    fireEvent.click(screen.getByRole('button', { name: /用本地覆盖/ }));
    expect(onResolveLocal).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  });

  it('手动处理… calls onOpenMerge with the row', () => {
    const onOpenMerge = vi.fn();
    renderRow(makeRow(), { onOpenMerge });
    fireEvent.click(screen.getByRole('button', { name: /手动处理/ }));
    expect(onOpenMerge).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
  });

  it('hides 用本地覆盖 when there is no local payload', () => {
    renderRow(makeRow({ local_payload: null }));
    expect(screen.queryByRole('button', { name: /用本地覆盖/ })).toBeNull();
  });

  it('hides resolve + merge for non-note entities', () => {
    renderRow(makeRow({ entity_type: 'folder' }));
    expect(screen.queryByRole('button', { name: /用本地覆盖/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /手动处理/ })).toBeNull();
  });
});

describe('ConflictsPage resolve flow (W7)', () => {
  it('用本地覆盖 sends the note updated_at as CAS baseline, then drops the row', async () => {
    vi.mocked(listConflicts)
      .mockResolvedValueOnce({ success: true, data: { conflicts: [makeRow()] } })
      .mockResolvedValue({ success: true, data: { conflicts: [] } });
    vi.mocked(getNote).mockResolvedValue({ success: true, data: makeNote() });
    vi.mocked(getConflictCount).mockResolvedValue({ success: true, data: { count: 0 } });
    vi.mocked(resolveConflict).mockResolvedValue({
      success: true,
      data: { resolved: true, note: makeNote({ content: 'my local text' }) },
    });

    render(
      <MemoryRouter>
        <ConflictsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /用本地覆盖/ }));

    await waitFor(() => expect(resolveConflict).toHaveBeenCalled());
    expect(resolveConflict).toHaveBeenCalledWith('c1', {
      strategy: 'local',
      expected_updated_at_ms: new Date('2026-02-02T12:00:00.000Z').getTime(),
    });
    // Row消行 after the post-resolve refreshList returns [].
    expect(await screen.findByText('没有未解决的冲突')).toBeTruthy();
  });

  it('blocks resolve when the note has an unsaved open tab (D9)', async () => {
    vi.mocked(listConflicts).mockResolvedValue({
      success: true,
      data: { conflicts: [makeRow()] },
    });
    render(
      <MemoryRouter>
        <ConflictsPage />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: /用本地覆盖/ });
    // Open a DIRTY tab for the conflicting note.
    useEditorStore.setState({ tabs: [makeTab({ dirty: true })], activeTabId: 'note-abcdef1234' });

    fireEvent.click(screen.getByRole('button', { name: /用本地覆盖/ }));

    expect(await screen.findByText(/未保存的修改/)).toBeTruthy();
    expect(getNote).not.toHaveBeenCalled();
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it('refreshes a clean open tab with the resolved content (D9)', async () => {
    vi.mocked(listConflicts)
      .mockResolvedValueOnce({ success: true, data: { conflicts: [makeRow()] } })
      .mockResolvedValue({ success: true, data: { conflicts: [] } });
    vi.mocked(getNote).mockResolvedValue({ success: true, data: makeNote() });
    vi.mocked(getConflictCount).mockResolvedValue({ success: true, data: { count: 0 } });
    const resolvedNote = makeNote({
      content: 'my local text',
      updatedAt: '2026-03-03T00:00:00.000Z',
    });
    vi.mocked(resolveConflict).mockResolvedValue({
      success: true,
      data: { resolved: true, note: resolvedNote },
    });

    render(
      <MemoryRouter>
        <ConflictsPage />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: /用本地覆盖/ });
    // A CLEAN tab for the note is open — it should be rebased to the resolved note.
    useEditorStore.setState({
      tabs: [makeTab({ content: 'stale', originalContent: 'stale' })],
      activeTabId: 'note-abcdef1234',
    });

    fireEvent.click(screen.getByRole('button', { name: /用本地覆盖/ }));

    await waitFor(() => expect(resolveConflict).toHaveBeenCalled());
    await waitFor(() => {
      const tab = useEditorStore.getState().tabs[0];
      expect(tab.content).toBe('my local text');
      expect(tab.originalUpdatedAt).toBe('2026-03-03T00:00:00.000Z');
    });
  });

  it('surfaces a friendly message on VERSION_MISMATCH (AC3)', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    vi.mocked(listConflicts).mockResolvedValue({
      success: true,
      data: { conflicts: [makeRow()] },
    });
    vi.mocked(getNote).mockResolvedValue({ success: true, data: makeNote() });
    vi.mocked(resolveConflict).mockRejectedValue(
      new ApiError(409, 'VERSION_MISMATCH', 'note version mismatch'),
    );

    render(
      <MemoryRouter>
        <ConflictsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /用本地覆盖/ }));
    expect(await screen.findByText(/被改动，请点击刷新后重试/)).toBeTruthy();
  });

  it('opens the merge dialog when 手动处理… is clicked', async () => {
    vi.mocked(listConflicts).mockResolvedValue({
      success: true,
      data: { conflicts: [makeRow()] },
    });
    render(
      <MemoryRouter>
        <ConflictsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /手动处理/ }));
    expect(await screen.findByText('手动处理冲突')).toBeTruthy();
  });

  it('does not touch ignore/count paths when nothing is clicked', async () => {
    vi.mocked(listConflicts).mockResolvedValue({ success: true, data: { conflicts: [] } });
    render(
      <MemoryRouter>
        <ConflictsPage />
      </MemoryRouter>,
    );
    await screen.findByText('没有未解决的冲突');
    expect(ignoreConflict).not.toHaveBeenCalled();
  });
});
