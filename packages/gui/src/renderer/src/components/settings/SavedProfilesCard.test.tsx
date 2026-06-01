/**
 * P5-d Phase 17 (delete-local-copy) — SavedProfilesCard RTL tests.
 *
 * Lists saved account profiles (local is filtered out) and deletes a local
 * copy behind a confirm Dialog. Radix Dialog is swapped for passthroughs that
 * honour `open` (same React-19/jsdom dup-dispatcher issue the other dialog/
 * popover tests mock around).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncProfilesReply } from '../../../../shared/sync-profiles-types.js';

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: ComponentProps<'div'>) => <div>{children}</div>,
  DialogHeader: ({ children }: ComponentProps<'div'>) => <div>{children}</div>,
  DialogTitle: ({ children }: ComponentProps<'div'>) => <div>{children}</div>,
  DialogDescription: ({ children }: ComponentProps<'div'>) => <div>{children}</div>,
  DialogFooter: ({ children }: ComponentProps<'div'>) => <div>{children}</div>,
}));

import { SavedProfilesCard } from './SavedProfilesCard';

const account = (id: string, over: Partial<SyncProfilesReply['profiles'][number]> = {}) => ({
  id,
  email: `${id}@test`,
  server_url: 'http://srv',
  is_active: false,
  can_quick_switch: true,
  db_missing: false,
  ...over,
});
const LOCAL = {
  id: 'local',
  email: null,
  server_url: null,
  is_active: true,
  can_quick_switch: false,
  db_missing: false,
};

function stubProfiles(profiles: SyncProfilesReply['profiles']): void {
  window.owlAPI.sync.profiles = vi.fn(() =>
    Promise.resolve({ ok: true as const, data: { active: 'local', profiles } }),
  );
}

beforeEach(() => {
  window.owlAPI.sync.deleteProfile = vi.fn(() =>
    Promise.resolve({ ok: true as const, data: { wasActive: false } }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SavedProfilesCard', () => {
  it('renders nothing for a pure-local user (only the local profile)', async () => {
    stubProfiles([LOCAL]);
    const { container } = render(<SavedProfilesCard />);
    await waitFor(() => expect(window.owlAPI.sync.profiles).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('lists saved account profiles (local excluded)', async () => {
    stubProfiles([LOCAL, account('pid-A'), account('pid-B')]);
    render(<SavedProfilesCard />);
    await waitFor(() => screen.getByText('pid-A@test'));
    expect(screen.getByText('pid-B@test')).toBeTruthy();
    expect(screen.queryByText('本地工作区')).toBeNull(); // local not listed
    expect(screen.getAllByRole('button', { name: '删除本地副本' })).toHaveLength(2);
  });

  it('opens a confirm dialog with the account email + irreversible warning', async () => {
    stubProfiles([LOCAL, account('pid-A')]);
    render(<SavedProfilesCard />);
    await waitFor(() => screen.getByText('pid-A@test'));
    fireEvent.click(screen.getByRole('button', { name: '删除本地副本' }));
    await waitFor(() => screen.getByText('删除账号本地副本'));
    expect(screen.getByText('此操作不可恢复')).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认删除' })).toBeTruthy();
  });

  it('确认删除 calls deleteProfile with the id and re-fetches', async () => {
    stubProfiles([LOCAL, account('pid-A')]);
    render(<SavedProfilesCard />);
    await waitFor(() => screen.getByText('pid-A@test'));
    expect(window.owlAPI.sync.profiles).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '删除本地副本' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(window.owlAPI.sync.deleteProfile).toHaveBeenCalledWith('pid-A'));
    await waitFor(() => expect(window.owlAPI.sync.profiles).toHaveBeenCalledTimes(2));
  });

  it('取消 closes the dialog without deleting', async () => {
    stubProfiles([LOCAL, account('pid-A')]);
    render(<SavedProfilesCard />);
    await waitFor(() => screen.getByText('pid-A@test'));
    fireEvent.click(screen.getByRole('button', { name: '删除本地副本' }));
    await waitFor(() => screen.getByText('删除账号本地副本'));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(window.owlAPI.sync.deleteProfile).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('删除账号本地副本')).toBeNull());
  });

  it('surfaces an error in the dialog when delete fails', async () => {
    stubProfiles([LOCAL, account('pid-A')]);
    window.owlAPI.sync.deleteProfile = vi.fn(() =>
      Promise.resolve({ ok: false as const, message: '无法连接到本地后台服务' }),
    );
    render(<SavedProfilesCard />);
    await waitFor(() => screen.getByText('pid-A@test'));
    fireEvent.click(screen.getByRole('button', { name: '删除本地副本' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => screen.getByText('无法连接到本地后台服务'));
  });

  it('marks the active account with 当前 and a db-missing one with 本地副本缺失', async () => {
    stubProfiles([
      LOCAL,
      account('pid-active', { is_active: true }),
      account('pid-ghost', { can_quick_switch: false, db_missing: true }),
    ]);
    render(<SavedProfilesCard />);
    await waitFor(() => screen.getByText('pid-active@test'));
    expect(screen.getByText('当前')).toBeTruthy();
    expect(screen.getByText('本地副本缺失')).toBeTruthy();
  });
});
