import { useSessionEpoch } from '@/stores/session-epoch';
import { Loader2 } from 'lucide-react';

/**
 * ③ — covers the "clear → refill" window while `bootstrapSession` brings a
 * session up, so a profile switch shows a brief spinner instead of either a
 * reload white-flash or a flash of empty stores. Renders nothing once the
 * session is `active`.
 *
 * Mounted OUTSIDE the epoch-keyed session root (in `NormalSessionShell`) so it
 * is not itself torn down by the remount it is covering.
 */
export function BootstrapOverlay(): React.ReactElement | null {
  const phase = useSessionEpoch((s) => s.phase);
  if (phase !== 'bootstrapping') return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="size-6 animate-spin" aria-hidden />
        <span className="text-sm">加载中…</span>
      </div>
    </div>
  );
}
