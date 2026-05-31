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
import { describe, expect, it, vi } from 'vitest';

// Settings sections pull from zustand stores / IPC; stub them all to a
// noop sentinel so we can assert tab selection without spinning real UI.
vi.mock('@/components/settings/ShortcutsSection', () => ({
  ShortcutsSection: () => <div data-testid="section-shortcuts" />,
}));
vi.mock('@/components/settings/AppearanceSection', () => ({
  AppearanceSection: () => <div data-testid="section-appearance" />,
}));
vi.mock('@/components/settings/CustomSection', () => ({
  CustomSection: () => <div data-testid="section-custom" />,
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
});
