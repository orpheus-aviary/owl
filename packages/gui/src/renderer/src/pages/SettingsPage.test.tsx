/**
 * P5-d Phase 8 — SettingsPage tab deep-link tests.
 *
 * HashRouter + react-router-dom@7 surfaces `?tab=sync` from
 * `#/settings?tab=sync` via useSearchParams. The page must:
 *   - default to 'appearance' when no/invalid `?tab=` is present
 *   - select 'sync' when `?tab=sync` is present (entry point used by
 *     SyncStatusBar.popover's "管理账号" link)
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// useIsMobile drives the single-column mobile layout. Default false (desktop);
// individual tests flip `mobileMock.value` to exercise the mobile shell.
const mobileMock = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => mobileMock.value }));

// Settings sections pull from zustand stores / IPC; stub them all to a
// noop sentinel so we can assert tab selection without spinning real UI.
vi.mock('@/components/settings/ShortcutsSection', () => ({
  ShortcutsSection: () => <div data-testid="section-shortcuts" />,
}));
vi.mock('@/components/settings/AppearanceSection', () => ({
  AppearanceSection: () => <div data-testid="section-appearance" />,
}));
// Record the props CustomSection receives so we can assert `hideSecrets` on mobile.
const customProps = vi.hoisted(() => ({ last: null as { hideSecrets?: boolean } | null }));
vi.mock('@/components/settings/CustomSection', () => ({
  CustomSection: (props: { hideSecrets?: boolean }) => {
    customProps.last = props;
    return <div data-testid="section-custom" />;
  },
}));
vi.mock('@/components/settings/SyncSection', () => ({
  SyncSection: () => <div data-testid="section-sync" />,
}));
vi.mock('@/components/settings/AdvancedSection', () => ({
  AdvancedSection: () => <div data-testid="section-advanced" />,
}));

import { SettingsPage } from './SettingsPage';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mobileMock.value = false;
  customProps.last = null;
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('SettingsPage tab deep-link', () => {
  it('opens 同步 tab when ?tab=sync', () => {
    renderAt('/settings?tab=sync');
    expect(screen.getByTestId('section-sync')).toBeTruthy();
  });

  it('falls back to 外观 when ?tab=bogus', () => {
    renderAt('/settings?tab=bogus');
    expect(screen.getByTestId('section-appearance')).toBeTruthy();
  });

  it('falls back to 外观 when no ?tab param', () => {
    renderAt('/settings');
    expect(screen.getByTestId('section-appearance')).toBeTruthy();
  });

  it('renders CustomSection without hideSecrets on desktop', () => {
    renderAt('/settings?tab=custom');
    expect(customProps.last?.hideSecrets).toBe(false);
  });
});

describe('SettingsPage — mobile single-column (Step 6)', () => {
  it('omits the 快捷键 tab from the mobile switcher', () => {
    mobileMock.value = true;
    renderAt('/settings');
    expect(screen.queryByRole('button', { name: '快捷键' })).toBeNull();
    // The other four tabs are still there.
    for (const label of ['外观', '自定义', '同步', '高级']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('redirects a hidden ?tab=shortcuts deep-link to 外观', () => {
    mobileMock.value = true;
    renderAt('/settings?tab=shortcuts');
    // Body renders the effective (appearance) section, never the hidden one.
    expect(screen.getByTestId('section-appearance')).toBeTruthy();
    expect(screen.queryByTestId('section-shortcuts')).toBeNull();
  });

  it('passes hideSecrets to CustomSection on mobile', () => {
    mobileMock.value = true;
    renderAt('/settings?tab=custom');
    expect(customProps.last?.hideSecrets).toBe(true);
  });
});
