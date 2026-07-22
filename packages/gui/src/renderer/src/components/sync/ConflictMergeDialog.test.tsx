import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConflictMergeDialog } from './ConflictMergeDialog';

// The real @codemirror/merge MergeView mounts fine in jsdom, so we exercise it
// directly. The right ("result") pane is seeded from remoteContent, so an
// un-edited submit returns exactly that — which proves `handleConfirm` reads
// the editable b-pane's live doc.

describe('ConflictMergeDialog', () => {
  it('renders both pane labels + description when open', () => {
    render(
      <ConflictMergeDialog
        open
        localContent="local"
        remoteContent="remote"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText('手动处理冲突')).toBeTruthy();
    // Exact match: the description sentence also contains these phrases, so a
    // regex would match multiple nodes.
    expect(screen.getByText('本地副本（只读）')).toBeTruthy();
    expect(screen.getByText('最终结果（可编辑）')).toBeTruthy();
  });

  it('submits the right-pane (result) doc', () => {
    const onSubmit = vi.fn();
    render(
      <ConflictMergeDialog
        open
        localContent="local copy"
        remoteContent="remote result"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /保存合并结果/ }));
    // Un-edited result pane == the seeded remote content.
    expect(onSubmit).toHaveBeenCalledWith('remote result');
  });

  it('cancel fires onCancel without submitting', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(
      <ConflictMergeDialog
        open
        localContent="local"
        remoteContent="remote"
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /取消/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables the buttons while submitting', () => {
    render(
      <ConflictMergeDialog
        open
        localContent="local"
        remoteContent="remote"
        submitting
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /保存中/ }).hasAttribute('disabled')).toBe(true);
  });
});
