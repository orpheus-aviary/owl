import { cn } from '@/lib/utils';
import { useConflictsStore } from '@/stores/conflicts-store';
import { MoreHorizontal } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PRIMARY_NAV, isEditorActive } from './mobile-nav';

/**
 * Bottom tab bar (§3.2). Four primary destinations + a "更多" trigger. Each
 * slot is ≥44px and reports `aria-current`. The 编辑 tab stays active across
 * both `/` and the `/note/:id` detail route; conflicts live in the 更多 sheet
 * and surface a count badge on the trigger. Hidden on the detail route by the
 * shell.
 */
export function MobileBottomNav({ onOpenMore }: { onOpenMore: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const conflictCount = useConflictsStore((s) => s.count);

  const isActive = (path: string) =>
    path === '/' ? isEditorActive(location.pathname) : location.pathname === path;

  return (
    <nav
      className="shrink-0 flex border-t border-border bg-sidebar text-sidebar-foreground pb-[env(safe-area-inset-bottom)]"
      aria-label="主导航"
    >
      {PRIMARY_NAV.map((item) => {
        const active = isActive(item.path);
        return (
          <button
            key={item.path}
            type="button"
            onClick={() => navigate(item.path)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-0.5 min-h-[52px] py-1 text-[10px] transition-colors',
              active ? 'text-sidebar-primary' : 'text-muted-foreground',
            )}
          >
            <item.icon className="size-5" />
            {item.label}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onOpenMore}
        aria-label="更多"
        className="relative flex flex-1 flex-col items-center justify-center gap-0.5 min-h-[52px] py-1 text-[10px] text-muted-foreground transition-colors"
      >
        <MoreHorizontal className="size-5" />
        更多
        {conflictCount > 0 && (
          <span className="absolute top-1 right-[22%] min-w-[16px] h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] leading-4 text-center font-medium">
            {conflictCount > 99 ? '99+' : conflictCount}
          </span>
        )}
      </button>
    </nav>
  );
}
