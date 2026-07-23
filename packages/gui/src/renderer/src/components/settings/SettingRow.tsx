import { useIsMobile } from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';

/**
 * A label/value row inside the bordered setting cards in the 同步 tab.
 *
 * On the mobile web shell it stacks vertically (label above, value/input below)
 * so full-width inputs — the LoginForm's server/email/password fields — fit a
 * phone instead of overflowing the fixed `w-72`. Desktop keeps the horizontal
 * `justify-between` layout byte-identical (`useIsMobile` is a hard `false` on
 * Electron and on wide web).
 */
export function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  const isMobile = useIsMobile();
  return (
    <div
      className={cn(
        'gap-4 px-4 py-3',
        isMobile ? 'flex flex-col items-stretch gap-2' : 'flex items-center justify-between',
      )}
    >
      <span className="text-sm">{label}</span>
      <div className={cn('flex items-center gap-2', isMobile && 'flex-wrap')}>{children}</div>
    </div>
  );
}
