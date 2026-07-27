import type { TabState } from '@/stores/editor-store';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Zustand's react binding resolves its own React copy under pnpm → the
// dup-instance hook check fails. Mock the hook to return a fixed store
// shape; the tests only read `tabs` and `activeTabId`.
const storeState: {
  tabs: TabState[];
  activeTabId: string | null;
  setActiveTab: (id: string) => void;
} = {
  tabs: [],
  activeTabId: null,
  setActiveTab: () => {},
};

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: <T,>(selector: (s: typeof storeState) => T): T => selector(storeState),
}));

import { TabBar } from './TabBar';

function makeTab(noteId: string, title: string, preview: boolean): TabState {
  return {
    noteId,
    title,
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
    preview,
    remoteUpdated: false,
  };
}

describe('TabBar — preview italic (P3.4-e)', () => {
  it('preview tab title renders with `italic` class', () => {
    storeState.tabs = [makeTab('n1', 'Preview note', true)];
    storeState.activeTabId = 'n1';
    const { getByText } = render(<TabBar onCloseTab={vi.fn()} />);
    expect(getByText('Preview note').className).toContain('italic');
  });

  it('pinned tab title does NOT have `italic` class', () => {
    storeState.tabs = [makeTab('n1', 'Pinned note', false)];
    storeState.activeTabId = 'n1';
    const { getByText } = render(<TabBar onCloseTab={vi.fn()} />);
    expect(getByText('Pinned note').className).not.toContain('italic');
  });

  it('preview and pinned tabs side by side render with different classes', () => {
    storeState.tabs = [makeTab('n1', 'Preview', true), makeTab('n2', 'Pinned', false)];
    storeState.activeTabId = 'n1';
    const { getByText } = render(<TabBar onCloseTab={vi.fn()} />);
    expect(getByText('Preview').className).toContain('italic');
    expect(getByText('Pinned').className).not.toContain('italic');
  });
});
