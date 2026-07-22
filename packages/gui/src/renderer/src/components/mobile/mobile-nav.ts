import {
  Bell,
  Bot,
  CheckSquare,
  type LucideIcon,
  PenSquare,
  Search,
  Settings,
  Trash2,
} from 'lucide-react';

/** One entry in the mobile bottom nav / "更多" sheet. */
export interface MobileNavItem {
  path: string;
  label: string;
  icon: LucideIcon;
}

/** The five persistent bottom-nav slots (the 5th is the "更多" sheet trigger,
 *  rendered by MobileBottomNav itself). */
export const PRIMARY_NAV: readonly MobileNavItem[] = [
  { path: '/', label: '编辑', icon: PenSquare },
  { path: '/browser', label: '浏览', icon: Search },
  { path: '/reminders', label: '提醒', icon: Bell },
  { path: '/todo', label: '待办', icon: CheckSquare },
];

/** The overflow destinations shown inside the "更多" sheet. Conflicts is not
 *  here — it's appended dynamically (count-gated, with a badge). */
export const MORE_NAV: readonly MobileNavItem[] = [
  { path: '/trash', label: '回收站', icon: Trash2 },
  { path: '/ai', label: 'AI', icon: Bot },
  { path: '/settings', label: '设置', icon: Settings },
];

/** Top-bar title for a page route (detail routes derive their title elsewhere). */
export const PAGE_TITLES: Record<string, string> = {
  '/': '编辑',
  '/browser': '浏览',
  '/reminders': '提醒',
  '/todo': '待办',
  '/trash': '回收站',
  '/ai': 'AI',
  '/settings': '设置',
  '/conflicts': '冲突',
};

/** The 编辑 tab owns both `/` and the `/note/:id` detail route. */
export function isEditorActive(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/note/');
}
