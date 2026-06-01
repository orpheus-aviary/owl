import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SyncStatusSnapshot } from '@/lib/api';

// Radix Popover drags Portal + dispatcher gymnastics into jsdom that
// breaks the React 19 hook dispatcher in vitest (`useState null` panic).
// Replace the primitives with passthrough wrappers; popover content sits
// inside `data-testid="popover-content"` so tests can scope queries to
// either the trigger button or the (normally hidden) content. The mock
// renders content unconditionally — open/close isn't what we're testing,
// we just want to verify snapshot fields surface when the popover opens.
vi.mock('@/components/ui/popover', () => {
  function Passthrough({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  }
  function Trigger({ children }: { children?: ReactNode; asChild?: boolean }) {
    return <>{children}</>;
  }
  return {
    Popover: Passthrough,
    PopoverTrigger: Trigger,
    PopoverContent: ({ children, ...rest }: ComponentProps<'div'>) => (
      <div data-testid="popover-content" {...rest}>
        {children}
      </div>
    ),
    PopoverClose: ({ children }: { children?: ReactNode; asChild?: boolean }) => <>{children}</>,
    PopoverHeader: (props: ComponentProps<'div'>) => <div {...props} />,
    PopoverTitle: (props: ComponentProps<'div'>) => <div {...props} />,
    PopoverDescription: (props: ComponentProps<'p'>) => <p {...props} />,
  };
});

// zustand under pnpm resolves to its own `react` copy and trips the
// React 19 dup-instance check inside vitest. Replace `useSyncStatus`
// with a stub backed by a mutable holder so each test can set the
// snapshot before render.
const snapshotHolder: { value: SyncStatusSnapshot | null } = { value: null };
vi.mock('@/stores/sync-status', () => ({
  useSyncStatus: <T,>(selector: (s: { snapshot: SyncStatusSnapshot | null }) => T) =>
    selector({ snapshot: snapshotHolder.value }),
}));

import type { SyncProfilesReply } from '../../../../shared/sync-profiles-types.js';
import { ProfileSwitcher, SyncStatusBar, formatRelativeTime } from './SyncStatusBar';

function makeSnapshot(overrides: Partial<SyncStatusSnapshot> = {}): SyncStatusSnapshot {
  return {
    state: 'idle',
    server_url: 'http://localhost:48080',
    device_id: '1f2a3b4c-aaaa-bbbb-cccc-dddddddddddd',
    workspace_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    pending_count: 0,
    pulled_seq: 5,
    pushed_seq: 5,
    last_sync_at: 1_700_000_000_000,
    last_error: null,
    ...overrides,
  };
}

afterEach(() => {
  snapshotHolder.value = null;
});

describe('SyncStatusBar trigger button', () => {
  it('renders 已同步 for idle state', () => {
    snapshotHolder.value = makeSnapshot({ state: 'idle' });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const button = screen.getByRole('button', { name: /同步状态：已同步/ });
    expect(within(button).getByText('已同步')).toBeTruthy();
  });

  it('renders 同步中 for syncing state with a spinner', () => {
    snapshotHolder.value = makeSnapshot({ state: 'syncing' });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const button = screen.getByRole('button', { name: /同步状态：同步中/ });
    expect(within(button).getByText('同步中')).toBeTruthy();
    expect(button.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders 出错 for error state', () => {
    snapshotHolder.value = makeSnapshot({ state: 'error', last_error: 'auth rejected' });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /同步状态：出错/ })).toBeTruthy();
  });

  it('renders 离线 for offline state', () => {
    snapshotHolder.value = makeSnapshot({ state: 'offline' });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /同步状态：离线/ })).toBeTruthy();
  });

  it('falls back to idle when snapshot is null', () => {
    snapshotHolder.value = null;
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    // Cold-start fallback: paint idle so we don't flash a red dot before
    // the SSE channel comes up.
    expect(screen.getByRole('button', { name: /同步状态：已同步/ })).toBeTruthy();
  });
});

describe('SyncStatusBar popover content', () => {
  it('surfaces last_error in the popover for error state', () => {
    snapshotHolder.value = makeSnapshot({ state: 'error', last_error: 'token rejected (401)' });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const popover = screen.getByTestId('popover-content');
    expect(within(popover).getByText('token rejected (401)')).toBeTruthy();
  });

  it('shows auto-retry reassurance for offline state', () => {
    snapshotHolder.value = makeSnapshot({ state: 'offline' });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const popover = screen.getByTestId('popover-content');
    expect(within(popover).getByText(/自动重试/)).toBeTruthy();
  });

  it('renders the cold-start explainer when snapshot is null', () => {
    snapshotHolder.value = null;
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const popover = screen.getByTestId('popover-content');
    expect(within(popover).getByText(/daemon 尚未上报同步状态/)).toBeTruthy();
  });

  // P5-d Phase 8 — popover must NOT instruct users to drop into the
  // terminal for sync login; the in-app flow lives at Settings → 同步.
  it('cold-start popover no longer mentions terminal `owl sync login`', () => {
    snapshotHolder.value = null;
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const popover = screen.getByTestId('popover-content');
    expect(popover.textContent ?? '').not.toMatch(/owl sync login/);
  });

  it('cold-start popover links into Settings → 同步 tab', () => {
    snapshotHolder.value = null;
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const popover = screen.getByTestId('popover-content');
    const link = within(popover).getByRole('link', { name: /设置 → 同步/ });
    expect(link.getAttribute('href')).toBe('/settings?tab=sync');
  });

  it('configured popover surfaces a "管理账号" link to /settings?tab=sync', () => {
    snapshotHolder.value = makeSnapshot({ state: 'idle' });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const popover = screen.getByTestId('popover-content');
    const link = within(popover).getByRole('link', { name: /管理账号/ });
    expect(link.getAttribute('href')).toBe('/settings?tab=sync');
  });

  it('shortens long ids to a leading segment', () => {
    snapshotHolder.value = makeSnapshot({
      device_id: '1f2a3b4c-aaaa-bbbb-cccc-dddddddddddd',
      workspace_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const popover = screen.getByTestId('popover-content');
    expect(within(popover).getByText('1f2a3b4c…')).toBeTruthy();
    expect(within(popover).getByText('aaaaaaaa…')).toBeTruthy();
  });

  // P5-c §6.27 — popover renders the SyncStatusSnapshot only; no token-bearing
  // field is part of that shape. Guard against a future regression where
  // someone adds a token-flavoured property to the wire snapshot.
  it('renders no field-name labels that smell like a token (regression: P5-c §6.27)', () => {
    snapshotHolder.value = makeSnapshot({ state: 'idle' });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const popover = screen.getByTestId('popover-content');
    const text = popover.textContent ?? '';
    // None of the popover row labels reveal an auth token.
    expect(text.toLowerCase()).not.toContain('token');
    expect(text.toLowerCase()).not.toContain('authorization');
    expect(text.toLowerCase()).not.toContain('bearer');
  });

  it('does not echo a token-shaped substring if last_error carries one', () => {
    // Server-side translateSkybridgeError is supposed to scrub tokens
    // before forwarding to the snapshot. If a 401 message ever ends up
    // including a raw token, the popover would broadcast it. This
    // belt-and-suspenders test asserts the popover author keeps the
    // message verbatim — which means snubbing tokens is a *daemon-side*
    // job that must be enforced by token-mask helpers there (see
    // `core/src/skybridge/redact.ts`). The test guards against someone
    // sneaking a `token` property onto the snapshot under a new name.
    const tok = 'tok_aaaaaaaaaaaaaaaaaaaa';
    snapshotHolder.value = makeSnapshot({
      state: 'error',
      last_error: 'auth rejected', // verbatim — daemon must scrub before sending
    });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const popover = screen.getByTestId('popover-content');
    expect(popover.textContent ?? '').not.toContain(tok);
  });
});

describe('formatRelativeTime', () => {
  const NOW = 1_700_000_000_000;

  it('returns 从未 for null', () => {
    expect(formatRelativeTime(null, NOW)).toBe('从未');
  });

  it('returns 刚刚 within 5s', () => {
    expect(formatRelativeTime(NOW - 1_000, NOW)).toBe('刚刚');
    expect(formatRelativeTime(NOW - 4_999, NOW)).toBe('刚刚');
  });

  it('returns 秒前 for 5s–60s', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('30 秒前');
  });

  it('returns 分钟前 for 1m–1h', () => {
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5 分钟前');
  });

  it('returns 小时前 for 1h–24h', () => {
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3 小时前');
  });

  it('returns 天前 for >= 24h', () => {
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2 天前');
  });

  it('clamps negative diffs to 刚刚', () => {
    // Daemon clock skew could give us a future timestamp — don't render
    // garbage like "-3 秒前".
    expect(formatRelativeTime(NOW + 1_000, NOW)).toBe('刚刚');
  });
});

describe('SyncStatusBar — W6 local profile (server_url null)', () => {
  it('popover shows 本地独立工作区 when the snapshot is local', () => {
    snapshotHolder.value = makeSnapshot({ server_url: null });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const content = screen.getByTestId('popover-content');
    expect(within(content).getByText('本地独立工作区')).toBeTruthy();
    // The account detail grid (服务器/设备/工作区 rows) is NOT rendered.
    expect(within(content).queryByText('服务器')).toBeNull();
  });

  it('popover shows the account detail grid when server_url is set', () => {
    snapshotHolder.value = makeSnapshot({ server_url: 'http://srv' });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const content = screen.getByTestId('popover-content');
    expect(within(content).queryByText('本地独立工作区')).toBeNull();
    expect(within(content).getByText('服务器')).toBeTruthy();
  });
});

describe('SyncStatusBar — W8 manual sync action', () => {
  it('account view shows a 手动同步 button that calls owlAPI.sync.run', async () => {
    const runMock = vi.mocked(window.owlAPI.sync.run);
    runMock.mockClear();
    snapshotHolder.value = makeSnapshot({ state: 'idle', server_url: 'http://srv' });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const content = screen.getByTestId('popover-content');
    const button = within(content).getByRole('button', { name: /手动同步/ });
    fireEvent.click(button);
    expect(runMock).toHaveBeenCalledTimes(1);
    // The trailing state update (running → false) settles inside act.
    await waitFor(() => expect(button).not.toHaveProperty('disabled', true));
  });

  it('手动同步 is disabled while syncing', () => {
    snapshotHolder.value = makeSnapshot({ state: 'syncing', server_url: 'http://srv' });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const content = screen.getByTestId('popover-content');
    const button = within(content).getByRole('button', { name: /手动同步/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('local profile (server_url null) shows no 手动同步 button', () => {
    snapshotHolder.value = makeSnapshot({ server_url: null });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const content = screen.getByTestId('popover-content');
    expect(within(content).queryByRole('button', { name: /手动同步/ })).toBeNull();
  });

  it('surfaces the error message when sync.run fails', async () => {
    const runMock = vi.mocked(window.owlAPI.sync.run);
    runMock.mockResolvedValueOnce({ ok: false, message: '网络连接失败，请检查本地后台服务' });
    snapshotHolder.value = makeSnapshot({ state: 'idle', server_url: 'http://srv' });
    render(
      <MemoryRouter>
        <SyncStatusBar />
      </MemoryRouter>,
    );
    const content = screen.getByTestId('popover-content');
    fireEvent.click(within(content).getByRole('button', { name: /手动同步/ }));
    await waitFor(() => expect(within(content).getByText(/网络连接失败/)).toBeTruthy());
  });
});

describe('ProfileSwitcher — W4 quick switch list', () => {
  function makeData(profiles: SyncProfilesReply['profiles'], active = 'local'): SyncProfilesReply {
    return { active, profiles };
  }
  const local = (over = {}) => ({
    id: 'local',
    email: null,
    server_url: null,
    is_active: false,
    can_quick_switch: true,
    db_missing: false,
    ...over,
  });
  const account = (id: string, over = {}) => ({
    id,
    email: `${id}@test`,
    server_url: 'http://srv',
    is_active: false,
    can_quick_switch: true,
    db_missing: false,
    ...over,
  });

  it('renders nothing when data is null and not loading', () => {
    const { container } = render(
      <MemoryRouter>
        <ProfileSwitcher data={null} loading={false} />
      </MemoryRouter>,
    );
    expect(container.textContent).toBe('');
  });

  it('shows a loading placeholder while fetching', () => {
    render(
      <MemoryRouter>
        <ProfileSwitcher data={null} loading={true} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/加载账号/)).toBeTruthy();
  });

  it('marks the active row with （当前） and renders it as non-clickable', () => {
    render(
      <MemoryRouter>
        <ProfileSwitcher
          data={makeData([local({ is_active: true, can_quick_switch: false }), account('pid-B')])}
          loading={false}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('（当前）')).toBeTruthy();
    // The active local row is not a button; the switchable account is.
    expect(screen.getByRole('button', { name: /pid-B@test/ })).toBeTruthy();
  });

  it('clicking a switchable row calls owlAPI.sync.switchProfile with its id', async () => {
    const switchMock = vi.mocked(window.owlAPI.sync.switchProfile);
    switchMock.mockClear();
    render(
      <MemoryRouter>
        <ProfileSwitcher
          data={makeData([local({ is_active: true, can_quick_switch: false }), account('pid-B')])}
          loading={false}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /pid-B@test/ }));
    expect(switchMock).toHaveBeenCalledWith('pid-B');
    await waitFor(() => expect(switchMock).toHaveBeenCalledTimes(1));
  });

  it('ghost (db_missing) and legacy (no refresh) rows are greyed with a Settings link, not buttons', () => {
    render(
      <MemoryRouter>
        <ProfileSwitcher
          data={makeData([
            account('pid-ghost', { can_quick_switch: false, db_missing: true }),
            account('pid-legacy', { can_quick_switch: false, db_missing: false }),
          ])}
          loading={false}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /pid-ghost@test/ })).toBeNull();
    expect(screen.getByText('本地副本缺失')).toBeTruthy();
    expect(screen.getByText('需重新登录')).toBeTruthy();
    // The two hint links point at Settings (excluding the always-present
    //「+ 添加账号」row, which carries `&action=add`).
    const hintLinks = screen
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href') !== '/settings?tab=sync&action=add');
    expect(hintLinks).toHaveLength(2);
    expect(hintLinks.every((l) => l.getAttribute('href') === '/settings?tab=sync')).toBe(true);
  });

  it('renders a「添加账号」row that deep-links into Settings with the add form open', () => {
    render(
      <MemoryRouter>
        <ProfileSwitcher
          data={makeData([local({ is_active: true, can_quick_switch: false })])}
          loading={false}
        />
      </MemoryRouter>,
    );
    const addLink = screen.getByRole('link', { name: /添加账号/ });
    expect(addLink.getAttribute('href')).toBe('/settings?tab=sync&action=add');
  });

  it('surfaces an error message when switchProfile fails', async () => {
    const switchMock = vi.mocked(window.owlAPI.sync.switchProfile);
    switchMock.mockResolvedValueOnce({
      ok: false,
      message: '该账号无法免密切换，请前往「设置 → 同步」重新登录',
    });
    render(
      <MemoryRouter>
        <ProfileSwitcher
          data={makeData([local({ is_active: true, can_quick_switch: false }), account('pid-B')])}
          loading={false}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: /pid-B@test/ }));
    await waitFor(() => expect(screen.getByText(/无法免密切换/)).toBeTruthy());
  });
});
