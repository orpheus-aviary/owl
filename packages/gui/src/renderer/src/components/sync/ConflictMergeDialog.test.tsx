import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictMergeDialog } from './ConflictMergeDialog';

// The real @codemirror/merge MergeView mounts fine in jsdom, so we exercise it
// directly. The right ("result") pane is seeded from remoteContent, so an
// un-edited submit returns exactly that — which proves `handleConfirm` reads
// the editable b-pane's live doc.
//
// useIsMobile is mocked with a mutable flag: it defaults false (desktop, real
// MergeView), and the mobile describe flips it on to exercise the §4.5 fallback.
const mobileMock = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobileMock.value }));

beforeEach(() => {
  mobileMock.value = false;
});

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

describe('ConflictMergeDialog — mobile fallback (§4.5)', () => {
  beforeEach(() => {
    mobileMock.value = true;
  });

  function renderMobile(over: Partial<React.ComponentProps<typeof ConflictMergeDialog>> = {}) {
    const props = {
      open: true as const,
      localContent: 'LOCAL',
      remoteContent: 'REMOTE',
      onCancel: vi.fn(),
      onSubmit: vi.fn(),
      onResolveLocal: vi.fn(),
      ...over,
    };
    render(<ConflictMergeDialog {...props} />);
    return props;
  }

  it('uses a single-column textarea seeded with remote — no MergeView', () => {
    renderMobile();
    // No CodeMirror MergeView in the DOM (its root carries `.cm-editor`).
    expect(document.querySelector('.cm-editor')).toBeNull();
    expect(screen.getByText('LOCAL')).toBeTruthy(); // read-only local block
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('REMOTE');
  });

  it('采用本地副本 fires onResolveLocal', () => {
    const props = renderMobile();
    fireEvent.click(screen.getByRole('button', { name: '采用本地副本' }));
    expect(props.onResolveLocal).toHaveBeenCalledTimes(1);
  });

  it('保存合并结果 submits the edited draft', () => {
    const props = renderMobile();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'EDITED' } });
    fireEvent.click(screen.getByRole('button', { name: '保存合并结果' }));
    expect(props.onSubmit).toHaveBeenCalledWith('EDITED');
  });

  it('omits 采用本地副本 when onResolveLocal is not provided', () => {
    renderMobile({ onResolveLocal: undefined });
    expect(screen.queryByRole('button', { name: '采用本地副本' })).toBeNull();
  });
});
