import type { Note } from '@/lib/api';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEditorStore } from './editor-store';

/**
 * Coverage for P2-8 step 6 — `applyNoteAppliedFromAi`:
 *   1. no open tab → no-op
 *   2. open + clean → silent overwrite, baselines reset
 *   3. open + dirty → auto-merge append, originalContent = DB
 *   4. dirty + 2nd apply → both appends land
 *
 * The action is pure state — no network calls — so we drive the zustand
 * store directly and snapshot `tabs` after each call.
 */

function makeNote(id: string, content: string): Note {
  return {
    id,
    content,
    tags: [],
    folderId: null,
    trashLevel: 0,
    createdAt: '',
    updatedAt: '',
    trashedAt: null,
    autoDeleteAt: null,
    deviceId: null,
    contentHash: null,
  };
}

function getTab(noteId: string) {
  return useEditorStore.getState().tabs.find((t) => t.noteId === noteId);
}

describe('applyNoteAppliedFromAi', () => {
  beforeEach(() => {
    useEditorStore.setState({ tabs: [], activeTabId: null });
  });

  it('no open tab → state is unchanged', () => {
    const before = useEditorStore.getState().tabs;
    useEditorStore.getState().applyNoteAppliedFromAi('memo', 'db', 'appended');
    expect(useEditorStore.getState().tabs).toBe(before);
  });

  it('clean tab → silent overwrite with DB content, baselines reset, dirty=false', () => {
    useEditorStore.getState().openNote(makeNote('memo', 'original'));
    useEditorStore.getState().applyNoteAppliedFromAi('memo', 'original\n\nmilk', 'milk');
    const tab = getTab('memo');
    expect(tab).toBeDefined();
    expect(tab?.content).toBe('original\n\nmilk');
    expect(tab?.originalContent).toBe('original\n\nmilk');
    expect(tab?.dirty).toBe(false);
  });

  it('dirty tab → auto-merge: user edits kept, AI text appended, baseline = DB', () => {
    useEditorStore.getState().openNote(makeNote('memo', 'baseline'));
    useEditorStore.getState().updateContent('memo', 'baseline + local edit');
    expect(getTab('memo')?.dirty).toBe(true);

    useEditorStore.getState().applyNoteAppliedFromAi('memo', 'baseline\n\nmilk', 'milk');

    const tab = getTab('memo');
    expect(tab?.content).toBe('baseline + local edit\n\nmilk');
    // New save baseline reflects what the DB currently holds (post-AI).
    expect(tab?.originalContent).toBe('baseline\n\nmilk');
    expect(tab?.dirty).toBe(true);
  });

  it('dirty tab + second apply → second append lands too', () => {
    useEditorStore.getState().openNote(makeNote('memo', 'baseline'));
    useEditorStore.getState().updateContent('memo', 'baseline + mine');

    useEditorStore.getState().applyNoteAppliedFromAi('memo', 'baseline\n\nmilk', 'milk');
    useEditorStore.getState().applyNoteAppliedFromAi('memo', 'baseline\n\nmilk\n\neggs', 'eggs');

    const tab = getTab('memo');
    expect(tab?.content).toBe('baseline + mine\n\nmilk\n\neggs');
    expect(tab?.originalContent).toBe('baseline\n\nmilk\n\neggs');
    expect(tab?.dirty).toBe(true);
  });
});
