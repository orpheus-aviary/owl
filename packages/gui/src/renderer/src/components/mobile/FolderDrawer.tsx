import { FolderPanel } from '@/components/FolderPanel';
import { SyncStatusBar } from '@/components/sync/SyncStatusBar';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';

/**
 * Left folder drawer (§3.5) — the mobile stand-in for the desktop folder panel.
 * Wraps `FolderPanel` in its `drawer` variant (single-tap opens a note + closes
 * the drawer) with the sync-status row pinned to the footer. No close button:
 * the drawer dismisses on backdrop tap, on any navigation (the shell closes it),
 * or when a note is opened.
 */
export function FolderDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="flex w-[85%] max-w-sm flex-col gap-0 p-0"
      >
        {/* Radix requires a title for the dialog; FolderPanel shows its own
            visible header, so this one is screen-reader-only. */}
        <SheetTitle className="sr-only">文件夹</SheetTitle>
        <div className="min-h-0 flex-1">
          <FolderPanel variant="drawer" onAfterOpen={() => onOpenChange(false)} />
        </div>
        <SyncStatusBar variant="drawer" />
      </SheetContent>
    </Sheet>
  );
}
