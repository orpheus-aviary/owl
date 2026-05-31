/**
 * P5-d Phase 16 (D10b) — ClaimAccountDialog RTL tests.
 *
 * Driven by the `sync:claim-prompt` IPC event (captured via the stubbed
 * `onClaimPrompt`); the choice goes back through `respondClaim`.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaimPromptInput } from '../../../shared/sync-claim-types.js';

// Radix Dialog (Portal + context) trips the React 19 hook dispatcher under
// vitest/jsdom (same dup-react issue the SyncStatusBar test hits with Popover).
// Swap the primitives for passthroughs that honour `open`.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: ComponentProps<'div'>) => <div>{children}</div>,
  DialogHeader: ({ children }: ComponentProps<'div'>) => <div>{children}</div>,
  DialogTitle: ({ children }: ComponentProps<'div'>) => <div>{children}</div>,
  DialogDescription: ({ children }: ComponentProps<'div'>) => <div>{children}</div>,
  DialogFooter: ({ children }: ComponentProps<'div'>) => <div>{children}</div>,
}));

import { ClaimAccountDialog } from './ClaimAccountDialog';

let trigger: ((input: ClaimPromptInput) => void) | null = null;

beforeEach(() => {
  trigger = null;
  window.owlAPI.sync.onClaimPrompt = vi.fn((cb: (input: ClaimPromptInput) => void) => {
    trigger = cb;
    return () => {};
  });
  window.owlAPI.sync.respondClaim = vi.fn();
});

afterEach(() => {
  vi.clearAllMocks();
});

function prompt(input: ClaimPromptInput): void {
  act(() => {
    trigger?.(input);
  });
}

describe('ClaimAccountDialog', () => {
  it('stays hidden until a prompt arrives', () => {
    render(<ClaimAccountDialog />);
    expect(screen.queryByText('本地笔记如何处理？')).toBeNull();
  });

  it('renders the note count + account email on prompt', async () => {
    render(<ClaimAccountDialog />);
    prompt({ email: 'a@test', localCount: 5, hasSyncTraces: false });
    await waitFor(() => screen.getByText('本地笔记如何处理？'));
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('a@test')).toBeTruthy();
    // No orphan warning when hasSyncTraces is false.
    expect(screen.queryByText(/旧同步痕迹/)).toBeNull();
  });

  it('并入账号 → respondClaim("merge") and closes', async () => {
    render(<ClaimAccountDialog />);
    prompt({ email: 'a@test', localCount: 3, hasSyncTraces: false });
    await waitFor(() => screen.getByText('本地笔记如何处理？'));
    fireEvent.click(screen.getByRole('button', { name: '并入账号' }));
    expect(window.owlAPI.sync.respondClaim).toHaveBeenCalledWith('merge');
    await waitFor(() => expect(screen.queryByText('本地笔记如何处理？')).toBeNull());
  });

  it('保持独立 → respondClaim("independent")', async () => {
    render(<ClaimAccountDialog />);
    prompt({ email: 'a@test', localCount: 3, hasSyncTraces: false });
    await waitFor(() => screen.getByText('本地笔记如何处理？'));
    fireEvent.click(screen.getByRole('button', { name: '保持独立' }));
    expect(window.owlAPI.sync.respondClaim).toHaveBeenCalledWith('independent');
  });

  it('shows the orphan warning when hasSyncTraces is true', async () => {
    render(<ClaimAccountDialog />);
    prompt({ email: 'a@test', localCount: 3, hasSyncTraces: true });
    await waitFor(() => screen.getByText('本地笔记如何处理？'));
    expect(screen.getByText(/旧同步痕迹/)).toBeTruthy();
  });
});
