import { render, screen } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// react-router-dom + React 19 + vitest jsdom trip the "Cannot read properties
// of null (reading 'useRef')" hook dispatcher bug under pnpm — same root
// cause as the Popover passthrough mock in SyncStatusBar.test.tsx. We don't
// need real routing for these tests; replace NavLink with a plain <a> that
// preserves className (via the function form) + title + role.
vi.mock('react-router-dom', () => {
  type NavLinkClass = string | ((args: { isActive: boolean }) => string);
  function NavLink({
    to,
    className,
    children,
    ...rest
  }: Omit<ComponentProps<'a'>, 'className'> & {
    to: string;
    className?: NavLinkClass;
    children?: ReactNode;
  }) {
    const cls = typeof className === 'function' ? className({ isActive: false }) : className;
    return (
      <a href={to} className={cls} {...rest}>
        {children}
      </a>
    );
  }
  return { NavLink };
});

// zustand under pnpm resolves to its own `react` copy and trips React 19's
// dup-instance check inside vitest. Use a mutable holder + stub so each
// test can set the count without involving the real store.
const conflictHolder: { count: number } = { count: 0 };
vi.mock('@/stores/conflicts-store', () => ({
  useConflictsStore: <T,>(selector: (s: { count: number }) => T) =>
    selector({ count: conflictHolder.count }),
}));

import { ConflictsNav } from './ConflictsNav';

describe('ConflictsNav (P5-c §6.19 / §6.33)', () => {
  afterEach(() => {
    conflictHolder.count = 0;
  });

  it('renders nothing when count is 0', () => {
    conflictHolder.count = 0;
    const { container } = render(<ConflictsNav />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the nav link and badge when count > 0', () => {
    conflictHolder.count = 3;
    render(<ConflictsNav />);
    expect(screen.queryByText('冲突')).not.toBeNull();
    const badge = screen.getByTestId('conflict-badge');
    expect(badge.textContent).toBe('3');
  });

  it('caps the displayed badge at "99+" when count > 99', () => {
    conflictHolder.count = 250;
    render(<ConflictsNav />);
    const badge = screen.getByTestId('conflict-badge');
    expect(badge.textContent).toBe('99+');
  });

  it('uses the absolute count in the title attribute (not the capped string)', () => {
    conflictHolder.count = 250;
    render(<ConflictsNav />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('title')).toBe('未解决的冲突 (250)');
  });
});
