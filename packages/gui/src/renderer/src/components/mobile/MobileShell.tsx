import { AppRoutes } from '@/components/AppRoutes';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { FolderDrawer } from './FolderDrawer';
import { MobileBottomNav } from './MobileBottomNav';
import { MobileTopBar } from './MobileTopBar';
import { MoreSheet } from './MoreSheet';

/**
 * Mobile shell (Stage 1 #5, §3.1). A full-viewport (`h-dvh`) column:
 *   [ top bar ] · [ AppRoutes — flex-1, the only scroll owner ] · [ bottom nav ]
 * The shell itself never scrolls (`overflow-hidden`); each page owns its scroll.
 * The bottom nav is hidden on the `/note/:id` detail route (§3.1). Every
 * navigation closes the folder drawer + the 更多 sheet (§3.4).
 */
export function MobileShell() {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  // Close the drawer + 更多 sheet on every navigation. `location` is the
  // trigger, not read in the body, hence the suppression.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire on navigation
  useEffect(() => {
    setDrawerOpen(false);
    setMoreOpen(false);
  }, [location]);

  const isDetail = location.pathname.startsWith('/note/');

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <MobileTopBar onOpenDrawer={() => setDrawerOpen(true)} />
      <main className="min-h-0 flex-1 overflow-hidden">
        <AppRoutes />
      </main>
      {!isDetail && <MobileBottomNav onOpenMore={() => setMoreOpen(true)} />}
      <FolderDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} />
    </div>
  );
}
