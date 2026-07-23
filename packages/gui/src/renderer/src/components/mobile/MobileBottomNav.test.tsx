import { useConflictsStore } from '@/stores/conflicts-store';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileBottomNav } from './MobileBottomNav';

function renderAt(path: string, onOpenMore = vi.fn()) {
  function wrapper({ children }: { children: ReactNode }) {
    return <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>;
  }
  return render(<MobileBottomNav onOpenMore={onOpenMore} />, { wrapper });
}

afterEach(() => {
  useConflictsStore.setState({ count: 0 });
});

describe('MobileBottomNav', () => {
  const current = (name: string) =>
    screen.getByRole('button', { name }).getAttribute('aria-current');

  it('marks the matching page active by pathname', () => {
    renderAt('/files');
    expect(current('文件')).toBe('page');
    expect(current('浏览')).toBeNull();
  });

  it('marks 浏览 active on /browser', () => {
    renderAt('/browser');
    expect(current('浏览')).toBe('page');
    expect(current('文件')).toBeNull();
  });

  it('shows a conflict count badge on 更多 only when there are conflicts', () => {
    useConflictsStore.setState({ count: 3 });
    renderAt('/');
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('caps the badge at 99+', () => {
    useConflictsStore.setState({ count: 150 });
    renderAt('/');
    expect(screen.getByText('99+')).toBeTruthy();
  });

  it('opens the 更多 sheet on tap', async () => {
    const onOpenMore = vi.fn();
    renderAt('/', onOpenMore);
    await userEvent.click(screen.getByRole('button', { name: '更多' }));
    expect(onOpenMore).toHaveBeenCalledOnce();
  });
});
