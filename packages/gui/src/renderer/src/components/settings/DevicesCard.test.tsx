/**
 * P5-d Phase 10 — DevicesCard RTL tests.
 *
 * Locks the §4 UX contract:
 *  - collapsed by default; no IPC at mount
 *  - first expand triggers exactly one sync.devices() call
 *  - second collapse → expand does NOT trigger another call (cache)
 *  - refresh button triggers a fresh call
 *  - is_current device is highlighted with the 当前 chip
 *  - error state shows a 重试 button which also re-fetches
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncDeviceEntry } from '../../../../shared/sync-devices-types.js';
import { DevicesCard, formatRelative } from './DevicesCard';

const DEVICE_CURRENT: SyncDeviceEntry = {
  id: 'dev-A',
  name: 'mac-a (owl)',
  platform: 'darwin',
  app_version: 'owl 0.4.2',
  client_version: '0.1.3',
  created_at: 1700000000000,
  last_seen_at: 1700000100000,
  is_current: true,
};
const DEVICE_OTHER: SyncDeviceEntry = {
  id: 'dev-B',
  name: 'mac-b (owl)',
  platform: 'darwin',
  app_version: 'owl 0.4.2',
  client_version: '0.1.3',
  created_at: 1700000200000,
  last_seen_at: 1700000300000,
  is_current: false,
};

const okDevices = (devices: SyncDeviceEntry[]) =>
  Promise.resolve({ ok: true as const, data: { devices } });
const failDevices = (message: string) => Promise.resolve({ ok: false as const, message });

beforeEach(() => {
  window.owlAPI.sync.devices = vi.fn(() => okDevices([DEVICE_CURRENT, DEVICE_OTHER]));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('DevicesCard — collapsed-by-default + cache contract', () => {
  it('mounts collapsed and does NOT call sync.devices at mount', () => {
    render(<DevicesCard />);
    expect(screen.getByRole('button', { name: /管理我的设备/ })).toBeTruthy();
    expect(window.owlAPI.sync.devices).not.toHaveBeenCalled();
  });

  it('first expand triggers sync.devices() exactly once', async () => {
    render(<DevicesCard />);
    fireEvent.click(screen.getByRole('button', { name: /管理我的设备/ }));
    await waitFor(() => {
      expect(window.owlAPI.sync.devices).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => screen.getByText('mac-a (owl)'));
  });

  it('collapse → expand reuses cache, no second sync.devices call', async () => {
    render(<DevicesCard />);
    const toggle = screen.getByRole('button', { name: /管理我的设备/ });

    fireEvent.click(toggle);
    await waitFor(() => screen.getByText('mac-a (owl)'));
    expect(window.owlAPI.sync.devices).toHaveBeenCalledTimes(1);

    // Collapse
    fireEvent.click(toggle);
    expect(screen.queryByText('mac-a (owl)')).toBeNull();

    // Re-expand — cached devices reappear, IPC count unchanged
    fireEvent.click(toggle);
    await waitFor(() => screen.getByText('mac-a (owl)'));
    expect(window.owlAPI.sync.devices).toHaveBeenCalledTimes(1);
  });

  it('refresh button triggers a fresh sync.devices call', async () => {
    render(<DevicesCard />);
    fireEvent.click(screen.getByRole('button', { name: /管理我的设备/ }));
    await waitFor(() => screen.getByText('mac-a (owl)'));
    expect(window.owlAPI.sync.devices).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '刷新设备列表' }));
    await waitFor(() => {
      expect(window.owlAPI.sync.devices).toHaveBeenCalledTimes(2);
    });
  });
});

describe('DevicesCard — render shape', () => {
  it('renders current device with 当前 chip + other devices without it', async () => {
    render(<DevicesCard />);
    fireEvent.click(screen.getByRole('button', { name: /管理我的设备/ }));
    await waitFor(() => screen.getByText('mac-a (owl)'));

    expect(screen.getByText('当前')).toBeTruthy();
    expect(screen.getByText('mac-b (owl)')).toBeTruthy();
    // 当前 chip appears exactly once (only current device gets it).
    expect(screen.getAllByText('当前')).toHaveLength(1);
  });

  it('shows device count in header after load', async () => {
    render(<DevicesCard />);
    fireEvent.click(screen.getByRole('button', { name: /管理我的设备/ }));
    await waitFor(() => screen.getByText(/管理我的设备 \(2\)/));
  });

  it('empty devices list renders 未发现任何设备', async () => {
    window.owlAPI.sync.devices = vi.fn(() => okDevices([]));
    render(<DevicesCard />);
    fireEvent.click(screen.getByRole('button', { name: /管理我的设备/ }));
    await waitFor(() => screen.getByText('未发现任何设备'));
  });
});

describe('DevicesCard — error path', () => {
  it('renders error message + 重试 button when sync.devices returns ok:false', async () => {
    window.owlAPI.sync.devices = vi.fn(() => failDevices('请在设置中重新登录'));
    render(<DevicesCard />);
    fireEvent.click(screen.getByRole('button', { name: /管理我的设备/ }));
    await waitFor(() => screen.getByText('请在设置中重新登录'));
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('clicking 重试 re-invokes sync.devices', async () => {
    let callCount = 0;
    window.owlAPI.sync.devices = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? failDevices('网络连接失败') : okDevices([DEVICE_CURRENT]);
    });
    render(<DevicesCard />);
    fireEvent.click(screen.getByRole('button', { name: /管理我的设备/ }));
    await waitFor(() => screen.getByRole('button', { name: '重试' }));

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => screen.getByText('mac-a (owl)'));
    expect(window.owlAPI.sync.devices).toHaveBeenCalledTimes(2);
  });
});

describe('DevicesCard — W9 remove device', () => {
  beforeEach(() => {
    window.owlAPI.sync.revokeDevice = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: { revoked: true } }),
    );
  });

  it('shows 移除 only on non-current devices', async () => {
    render(<DevicesCard />);
    fireEvent.click(screen.getByRole('button', { name: /管理我的设备/ }));
    await waitFor(() => screen.getByText('mac-b (owl)'));
    // Only the non-current device (dev-B) gets a 移除 button.
    expect(screen.getAllByRole('button', { name: '移除' })).toHaveLength(1);
  });

  it('confirm → 确认移除 revokes by id and re-fetches the list', async () => {
    render(<DevicesCard />);
    fireEvent.click(screen.getByRole('button', { name: /管理我的设备/ }));
    await waitFor(() => screen.getByText('mac-b (owl)'));
    expect(window.owlAPI.sync.devices).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    fireEvent.click(screen.getByRole('button', { name: '确认移除' }));
    await waitFor(() => expect(window.owlAPI.sync.revokeDevice).toHaveBeenCalledWith('dev-B'));
    // success → re-fetch (this row would disappear with a real server)
    await waitFor(() => expect(window.owlAPI.sync.devices).toHaveBeenCalledTimes(2));
  });

  it('取消 dismisses the confirm without revoking', async () => {
    render(<DevicesCard />);
    fireEvent.click(screen.getByRole('button', { name: /管理我的设备/ }));
    await waitFor(() => screen.getByText('mac-b (owl)'));
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(window.owlAPI.sync.revokeDevice).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '移除' })).toBeTruthy();
  });

  it('surfaces an error and keeps the row when revoke fails', async () => {
    window.owlAPI.sync.revokeDevice = vi.fn(() =>
      Promise.resolve({ ok: false as const, message: '请在设置中重新登录' }),
    );
    render(<DevicesCard />);
    fireEvent.click(screen.getByRole('button', { name: /管理我的设备/ }));
    await waitFor(() => screen.getByText('mac-b (owl)'));
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    fireEvent.click(screen.getByRole('button', { name: '确认移除' }));
    await waitFor(() => screen.getByText('请在设置中重新登录'));
    expect(screen.getByText('mac-b (owl)')).toBeTruthy(); // row not removed
  });
});

describe('formatRelative', () => {
  const NOW = 1700000000000;

  // Intl.RelativeTimeFormat with numeric:'auto' picks natural Chinese
  // ('前天', '昨天', '上个月' etc.) when the unit is small; for larger
  // units it falls back to '5 分钟前' style. Just verify the unit lands
  // in the right magnitude — exact wording is Intl's call, not ours.
  it('picks the right unit magnitude for explicit now', () => {
    expect(formatRelative(NOW - 30_000, NOW)).toMatch(/秒/);
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toMatch(/分/);
    expect(formatRelative(NOW - 3 * 3600_000, NOW)).toMatch(/小时/);
    expect(formatRelative(NOW - 5 * 86400_000, NOW)).toMatch(/天/);
    expect(formatRelative(NOW - 90 * 86400_000, NOW)).toMatch(/月/);
    expect(formatRelative(NOW - 800 * 86400_000, NOW)).toMatch(/年/);
  });
});
