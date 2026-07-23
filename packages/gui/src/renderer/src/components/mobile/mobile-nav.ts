import {
  Bell,
  Bot,
  CheckSquare,
  FolderTree,
  type LucideIcon,
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

/** The four persistent bottom-nav slots (the 5th is the "更多" sheet trigger,
 *  rendered by MobileBottomNav itself). 浏览 leads (it's the cold-start default,
 *  `/` → `/browser`). There is no 编辑 tab: the editor is a detail (`/note/:id`)
 *  reached only by tapping a note. */
export const PRIMARY_NAV: readonly MobileNavItem[] = [
  { path: '/browser', label: '浏览', icon: Search },
  { path: '/files', label: '文件', icon: FolderTree },
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

/** Top-bar title for a page route (the `/note/:id` detail derives its title from
 *  the active tab). A bare `/` redirects to `/browser`, but map it too so the
 *  top bar shows the right title during that redirect frame. */
export const PAGE_TITLES: Record<string, string> = {
  '/': '浏览',
  '/files': '文件',
  '/browser': '浏览',
  '/reminders': '提醒',
  '/todo': '待办',
  '/trash': '回收站',
  '/ai': 'AI',
  '/settings': '设置',
  '/conflicts': '冲突',
};
