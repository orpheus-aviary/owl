import { SyncStatusBar } from '@/components/sync/SyncStatusBar';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useConflictsStore } from '@/stores/conflicts-store';
import { AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { MORE_NAV } from './mobile-nav';

/**
 * The "更多" overflow sheet (§3.2) — the destinations that don't fit the four
 * bottom slots, plus the count-gated 冲突 entry, plus the sync-status row in the
 * footer (its old home, the folder drawer, is gone). Tapping a tile navigates;
 * the shell's `useEffect([location])` closes the sheet on the resulting route
 * change, so no explicit close is wired here.
 */
export function MoreSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const conflictCount = useConflictsStore((s) => s.count);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="rounded-t-xl pb-[env(safe-area-inset-bottom)]"
      >
        <SheetHeader>
          <SheetTitle>更多</SheetTitle>
        </SheetHeader>
        <div className="grid grid-cols-4 gap-2 px-4 pb-4">
          {MORE_NAV.map((item) => (
            <button
              key={item.path}
              type="button"
              onClick={() => navigate(item.path)}
              className="flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <item.icon className="size-6" />
              <span className="text-xs">{item.label}</span>
            </button>
          ))}
          {conflictCount > 0 && (
            <button
              type="button"
              onClick={() => navigate('/conflicts')}
              className="relative flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <AlertTriangle className="size-6 text-yellow-500" />
              <span className="text-xs">冲突</span>
              <span className="absolute top-1 right-2 min-w-[16px] h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] leading-4 text-center font-medium">
                {conflictCount > 99 ? '99+' : conflictCount}
              </span>
            </button>
          )}
        </div>
        {/* Sync status — moved here from the removed folder drawer. The drawer
            variant lays it out as a full-width row with an upward popover. */}
        <div className="border-t border-border px-2 py-1">
          <SyncStatusBar variant="drawer" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
