import { AppRoutes } from '@/components/AppRoutes';

/**
 * Mobile shell (Stage 1 #5) — SKELETON.
 *
 * The real two-state top bar, bottom nav and folder drawer land in Step 4;
 * for now it just hosts `AppRoutes` in a full-height (`h-dvh`), single-
 * scroll-owner column so the shell split from Step 2 is testable end to end.
 * Each page owns its own scroll — the shell itself never scrolls
 * (`overflow-hidden`).
 */
export function MobileShell() {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <main className="min-h-0 flex-1 overflow-hidden">
        <AppRoutes />
      </main>
    </div>
  );
}
