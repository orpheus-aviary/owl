import type { ConflictRecord } from '@/lib/api';
import { openNoteById } from '@/stores/editor-store';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictRow } from './ConflictsPage';

vi.mock('@/stores/editor-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/editor-store')>()),
  openNoteById: vi.fn(),
}));

const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  writeText.mockClear();
  vi.mocked(openNoteById).mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
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

function renderRow(row: ConflictRecord, onIgnore = vi.fn()) {
  return render(
    <MemoryRouter>
      <ConflictRow row={row} onIgnore={onIgnore} />
    </MemoryRouter>,
  );
}

describe('ConflictRow copy button (Feature A — 复制输方内容)', () => {
  it('copies the local (losing) content and flips to 已复制', async () => {
    renderRow(makeRow());
    fireEvent.click(screen.getByRole('button', { name: /复制/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('my local text'));
    // findByText throws if the 已复制 state never renders; assert it resolved.
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
