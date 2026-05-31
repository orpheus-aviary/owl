/**
 * P5-d Phase 8 — SyncSection.tsx RTL tests.
 *
 * The "single display truth" contract (Settings reads identity ONLY
 * from sync:status, never from sync:login's reply) is the highest-value
 * thing to lock down here, so most cases drive that loop end-to-end:
 *   - mount → sync.status called once
 *   - submit form → sync.login called with the form values
 *   - login success → sync.status called again → identity rendered
 *   - logout confirm → sync.logout called → status refresh → unauth
 *   - error replies (api / safe_storage_unavailable / network) → preserved
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncSection } from './SyncSection';

// shared/SyncStatusReply shape used in fixtures.
type Session = {
  email: string;
  server_url: string;
  workspace_slug: string | null;
  workspace_id: string;
  device_id: string;
  device_name: string;
};

const FULL_SESSION: Session = {
  email: 'a@test',
  server_url: 'http://srv',
  workspace_slug: 'owl/default',
  workspace_id: 'ws-A',
  device_id: 'dev-A',
  device_name: 'mac-a',
};

const okStatus = (sessionOverride: Session | null = FULL_SESSION) =>
  Promise.resolve({
    ok: true as const,
    data: { session: sessionOverride, snapshot: null },
  });

const okVoid = () => Promise.resolve({ ok: true as const, data: undefined });
const failVoid = (message: string) => Promise.resolve({ ok: false as const, message });

beforeEach(() => {
  // Reset stubs to default (unauthenticated) each test so cases compose.
  window.owlAPI.sync.login = vi.fn(okVoid);
  window.owlAPI.sync.logout = vi.fn(okVoid);
  window.owlAPI.sync.status = vi.fn(() => okStatus(null));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('SyncSection — unauth → login → auth flow', () => {
  it('renders the form after initial sync.status returns no session', async () => {
    render(<SyncSection />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
    });
    expect(window.owlAPI.sync.status).toHaveBeenCalledTimes(1);
  });

  it('submits camelCase input + refreshes status on success', async () => {
    let calledStatusTimes = 0;
    window.owlAPI.sync.status = vi.fn(() => {
      calledStatusTimes += 1;
      return calledStatusTimes === 1 ? okStatus(null) : okStatus(FULL_SESSION);
    });
    render(<SyncSection />);
    await waitFor(() => screen.getByRole('button', { name: '登录' }));

    fireEvent.change(screen.getByDisplayValue('http://127.0.0.1:8443'), {
      target: { value: 'http://srv' },
    });
    // Use the input labels; the form has exactly one of each.
    const emailInput = screen
      .getAllByRole('textbox')
      .find((el) => el.getAttribute('type') === 'email');
    expect(emailInput).toBeTruthy();
    fireEvent.change(emailInput as HTMLElement, { target: { value: 'a@test' } });
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: 'pw' } });

    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => {
      expect(window.owlAPI.sync.login).toHaveBeenCalledWith({
        serverUrl: 'http://srv',
        email: 'a@test',
        password: 'pw',
      });
    });
    await waitFor(() => {
      // Identity from the SECOND status call — not from sync.login's reply.
      expect(screen.getByText('a@test')).toBeTruthy();
      expect(screen.getByText('owl/default')).toBeTruthy();
      expect(screen.getByText('mac-a')).toBeTruthy();
    });
    expect(window.owlAPI.sync.status).toHaveBeenCalledTimes(2);
  });

  it('surfaces 邮箱或密码不正确 on INVALID_CREDENTIALS reply, keeps form mounted', async () => {
    window.owlAPI.sync.login = vi.fn(() => failVoid('邮箱或密码不正确'));
    render(<SyncSection />);
    await waitFor(() => screen.getByRole('button', { name: '登录' }));

    const emailInput = screen
      .getAllByRole('textbox')
      .find((el) => el.getAttribute('type') === 'email');
    fireEvent.change(emailInput as HTMLElement, { target: { value: 'a@test' } });
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, {
      target: { value: 'bad' },
    });

    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => {
      expect(screen.getByText('邮箱或密码不正确')).toBeTruthy();
    });
    // Form stays mounted.
    expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
  });

  it('surfaces 系统钥匙串不可用 for SafeStorageUnavailable replies', async () => {
    window.owlAPI.sync.login = vi.fn(() => failVoid('系统钥匙串不可用，无法安全存储登录凭证'));
    render(<SyncSection />);
    await waitFor(() => screen.getByRole('button', { name: '登录' }));

    const emailInput = screen
      .getAllByRole('textbox')
      .find((el) => el.getAttribute('type') === 'email');
    fireEvent.change(emailInput as HTMLElement, { target: { value: 'a@test' } });
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, {
      target: { value: 'pw' },
    });

    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => {
      expect(screen.getByText(/系统钥匙串不可用/)).toBeTruthy();
    });
  });
});

describe('SyncSection — auth → logout flow', () => {
  beforeEach(() => {
    window.owlAPI.sync.status = vi.fn(() => okStatus(FULL_SESSION));
  });

  it('renders identity fields from sync.status', async () => {
    render(<SyncSection />);
    await waitFor(() => {
      expect(screen.getByText('a@test')).toBeTruthy();
      expect(screen.getByText('owl/default')).toBeTruthy();
      expect(screen.getByText('mac-a')).toBeTruthy();
    });
  });

  it('falls back to workspace_id when workspace_slug is null', async () => {
    window.owlAPI.sync.status = vi.fn(() => okStatus({ ...FULL_SESSION, workspace_slug: null }));
    render(<SyncSection />);
    await waitFor(() => {
      expect(screen.getByText('ws-A')).toBeTruthy();
    });
  });

  it('confirms before logging out, then refreshes status to unauth', async () => {
    let calledStatusTimes = 0;
    window.owlAPI.sync.status = vi.fn(() => {
      calledStatusTimes += 1;
      return calledStatusTimes === 1 ? okStatus(FULL_SESSION) : okStatus(null);
    });
    render(<SyncSection />);
    await waitFor(() => screen.getByText('a@test'));

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    // First click → confirmation step, no logout call yet.
    expect(window.owlAPI.sync.logout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认退出' }));

    await waitFor(() => {
      expect(window.owlAPI.sync.logout).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '登录' })).toBeTruthy();
    });
  });

  it('cancel button in logout confirm leaves session intact', async () => {
    render(<SyncSection />);
    await waitFor(() => screen.getByText('a@test'));

    fireEvent.click(screen.getByRole('button', { name: '退出登录' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(window.owlAPI.sync.logout).not.toHaveBeenCalled();
    expect(screen.getByText('a@test')).toBeTruthy();
  });

  it('renders DevicesCard collapsed header in auth view, does NOT fetch devices', async () => {
    render(<SyncSection />);
    await waitFor(() => screen.getByText('a@test'));
    // Sub-card header is present + collapsed (no device row rendered yet)
    expect(screen.getByRole('button', { name: /管理我的设备/ })).toBeTruthy();
    expect(window.owlAPI.sync.devices).not.toHaveBeenCalled();
  });
});

describe('SyncSection — DevicesCard wiring', () => {
  it('does NOT render DevicesCard in unauth view', async () => {
    // Default beforeEach gives an unauthenticated session.
    render(<SyncSection />);
    await waitFor(() => screen.getByRole('button', { name: '登录' }));
    expect(screen.queryByRole('button', { name: /管理我的设备/ })).toBeNull();
  });
});

describe('SyncSection — W6 local-workspace banner', () => {
  const LOCAL_SNAPSHOT = {
    configured: false,
    authenticated: false,
    server_url: null as string | null,
    device_id: null as string | null,
    workspace_id: null as string | null,
    pending_count: 0,
    pulled_seq: 0,
    pushed_seq: 0,
    last_sync_at: null as number | null,
  };
  const statusWith = (snapshot: typeof LOCAL_SNAPSHOT | null) =>
    Promise.resolve({ ok: true as const, data: { session: null, snapshot } });

  it('shows the banner when daemon reports a local profile (server_url null)', async () => {
    window.owlAPI.sync.status = vi.fn(() => statusWith(LOCAL_SNAPSHOT));
    render(<SyncSection />);
    await waitFor(() => screen.getByRole('button', { name: '登录' }));
    expect(screen.getByText(/本地独立工作区/)).toBeTruthy();
  });

  it('hides the banner when the daemon has not reported (snapshot null)', async () => {
    window.owlAPI.sync.status = vi.fn(() => statusWith(null));
    render(<SyncSection />);
    await waitFor(() => screen.getByRole('button', { name: '登录' }));
    expect(screen.queryByText(/本地独立工作区/)).toBeNull();
  });

  it('hides the banner for a broken account profile (session null but server_url set)', async () => {
    window.owlAPI.sync.status = vi.fn(() =>
      statusWith({ ...LOCAL_SNAPSHOT, server_url: 'http://srv' }),
    );
    render(<SyncSection />);
    await waitFor(() => screen.getByRole('button', { name: '登录' }));
    expect(screen.queryByText(/本地独立工作区/)).toBeNull();
  });
});
