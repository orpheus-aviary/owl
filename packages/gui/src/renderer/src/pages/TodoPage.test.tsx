import type { TodoGroup } from '@/lib/api';
import { describe, expect, it } from 'vitest';
import { mergeWithDirtyTabs } from './TodoPage';

function remoteGroup(noteId: string, createdAt: string): TodoGroup {
  return {
    note_id: noteId,
    note_title: noteId,
    created_at: createdAt,
    items: [{ line: 1, text: noteId, checked: false }],
  };
}

describe('mergeWithDirtyTabs — 待办 creation-order sort (newest created first)', () => {
  it('sorts remote groups by created_at desc', () => {
    const remote = [
      remoteGroup('old', '2026-01-01T00:00:00.000Z'),
      remoteGroup('new', '2026-06-01T00:00:00.000Z'),
      remoteGroup('mid', '2026-03-01T00:00:00.000Z'),
    ];
    const out = mergeWithDirtyTabs(remote, [], 'all');
    expect(out.map((g) => g.note_id)).toEqual(['new', 'mid', 'old']);
  });

  it('a dirty edit of an existing note keeps its creation position (no float-to-top)', () => {
    const remote = [
      remoteGroup('old', '2026-01-01T00:00:00.000Z'),
      remoteGroup('new', '2026-06-01T00:00:00.000Z'),
    ];
    const out = mergeWithDirtyTabs(
      remote,
      [{ noteId: 'old', content: '- [ ] edited', dirty: true }],
      'all',
    );
    // Editing the OLDER note must NOT bump it above the newer one.
    expect(out.map((g) => g.note_id)).toEqual(['new', 'old']);
    const oldGroup = out.find((g) => g.note_id === 'old');
    expect(oldGroup?.hasUnsaved).toBe(true);
    expect(oldGroup?.created_at).toBe('2026-01-01T00:00:00.000Z'); // real creation time preserved
  });

  it('a brand-new unsaved draft (no remote group) tops the list', () => {
    const remote = [remoteGroup('existing', '2020-01-01T00:00:00.000Z')];
    const out = mergeWithDirtyTabs(
      remote,
      [{ noteId: 'draft', content: '- [ ] brand new', dirty: true }],
      'all',
    );
    expect(out[0]?.note_id).toBe('draft'); // just-created → newest → top
  });

  it('drops a group whose dirty content has no todos under the open filter', () => {
    const remote = [remoteGroup('n', '2026-06-01T00:00:00.000Z')];
    const out = mergeWithDirtyTabs(
      remote,
      [{ noteId: 'n', content: 'plain text, no checkboxes', dirty: true }],
      'open',
    );
    expect(out).toHaveLength(0);
  });
});
