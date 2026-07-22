import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet';

function renderSheet(props: { open?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  return render(
    <Sheet {...props}>
      <SheetContent side="left">
        <SheetTitle>抽屉</SheetTitle>
        <SheetDescription>侧滑面板</SheetDescription>
        <div>body content</div>
      </SheetContent>
    </Sheet>,
  );
}

describe('Sheet', () => {
  it('renders its content (in a portal) when open', () => {
    renderSheet({ open: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('body content')).toBeTruthy();
    expect(screen.getByText('抽屉')).toBeTruthy();
  });

  it('renders nothing when closed', () => {
    renderSheet({ open: false });
    expect(screen.queryByText('body content')).toBeNull();
  });

  it('anchors to the requested side', () => {
    renderSheet({ open: true });
    const content = screen.getByRole('dialog');
    expect(content.className).toContain('left-0');
    expect(content.className).not.toContain('right-0');
  });

  it('requests close via onOpenChange when the X is clicked', async () => {
    const onOpenChange = vi.fn();
    renderSheet({ open: true, onOpenChange });
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
