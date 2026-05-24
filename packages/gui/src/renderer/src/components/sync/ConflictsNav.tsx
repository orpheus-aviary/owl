/**
 * P5-c §6.19 / §6.33 — sidebar 冲突 nav entry.
 *
 * Only rendered when `useConflictsStore.count > 0` — keeps the sidebar
 * uncluttered for the steady-state case. Shows a small red dot in the
 * corner with the count (capped at "99+" when over 99 — see §8 risk).
 */

import { useConflictsStore } from '@/stores/conflicts-store';
import { AlertTriangle } from 'lucide-react';
import { NavLink } from 'react-router-dom';

export function ConflictsNav() {
  const count = useConflictsStore((s) => s.count);
  if (count <= 0) return null;
  const display = count > 99 ? '99+' : String(count);

  return (
    <NavLink
      to="/conflicts"
      end
      draggable={false}
      className={({ isActive }) =>
        `relative flex flex-col items-center justify-center gap-0.5 h-14 text-[10px] transition-colors ${
          isActive
            ? 'text-sidebar-primary-foreground bg-sidebar-accent'
            : 'text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50'
        }`
      }
      title={`未解决的冲突 (${count})`}
    >
      <AlertTriangle className="size-4 text-yellow-500" />
      冲突
      <span
        data-testid="conflict-badge"
        className="absolute top-1.5 right-2 min-w-[16px] h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] leading-4 text-center font-medium"
      >
        {display}
      </span>
    </NavLink>
  );
}
