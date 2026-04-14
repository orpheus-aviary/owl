import { FolderPanel } from '@/components/FolderPanel';
import type { ShortcutsConfig } from '@/lib/api';
import { matchesShortcut } from '@/lib/shortcuts';
import { useBrowserStore } from '@/stores/browser-store';
import { useConfigStore } from '@/stores/config-store';
import { useEditorStore } from '@/stores/editor-store';
import { useFolderStore } from '@/stores/folder-store';
import {
  Bell,
  Bot,
  CheckSquare,
  FolderTree,
  type LucideIcon,
  PenSquare,
  Search,
  Settings,
  Trash2,
} from 'lucide-react';
import { useEffect } from 'react';
import { HashRouter, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { AIPage } from './pages/AIPage';
import { BrowserPage } from './pages/BrowserPage';
import { EditorPage } from './pages/EditorPage';
import { RemindersPage } from './pages/RemindersPage';
import { SettingsPage } from './pages/SettingsPage';
import { TodoPage } from './pages/TodoPage';
import { TrashPage } from './pages/TrashPage';

interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  shortcutKey: keyof ShortcutsConfig;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/', label: '编辑', icon: PenSquare, shortcutKey: 'nav_editor' },
  { path: '/browser', label: '浏览', icon: Search, shortcutKey: 'nav_browser' },
  { path: '/trash', label: '回收站', icon: Trash2, shortcutKey: 'nav_trash' },
  { path: '/reminders', label: '提醒', icon: Bell, shortcutKey: 'nav_reminders' },
  { path: '/todo', label: '待办', icon: CheckSquare, shortcutKey: 'nav_todo' },
  { path: '/ai', label: 'AI', icon: Bot, shortcutKey: 'nav_ai' },
  { path: '/settings', label: '设置', icon: Settings, shortcutKey: 'nav_settings' },
];

/**
 * Global window-level shortcut dispatcher. Page navigation (Cmd+1..7) fires
 * everywhere; the folder panel toggle is scoped away from the CodeMirror
 * editor because its default Cmd+B collides with the markdown bold command.
 */
function dispatchNavShortcut(e: KeyboardEvent, navigate: (path: string) => void): boolean {
  const shortcuts = useConfigStore.getState().shortcuts;
  for (const item of NAV_ITEMS) {
    const binding = shortcuts[item.shortcutKey];
    if (binding && matchesShortcut(e, binding)) {
      e.preventDefault();
      navigate(item.path);
      return true;
    }
  }
  const toggleBinding = shortcuts.toggle_folder_panel;
  if (toggleBinding && matchesShortcut(e, toggleBinding)) {
    const target = e.target as Element | null;
    if (target?.closest('.cm-editor')) return false;
    e.preventDefault();
    useFolderStore.getState().togglePanel();
    return true;
  }
  return false;
}

function NavShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      dispatchNavShortcut(e, navigate);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  return null;
}

export function App() {
  // Load config once on mount — subsequent changes are pushed by PATCH /config.
  // After the initial fetch, hydrate session-level defaults (editor mode +
  // browser sort) from config. These one-shot writes only apply to the current
  // session; users can still change them live without the settings overriding.
  useEffect(() => {
    void useConfigStore
      .getState()
      .fetch()
      .then(() => {
        const { editor, browser } = useConfigStore.getState();
        useEditorStore.getState().setMode(editor.default_mode);
        const sortKey = `${browser.default_sort_field}_${browser.default_sort_direction}` as const;
        useBrowserStore.getState().setSortKey(sortKey);
      });
  }, []);

  const panelOpen = useFolderStore((s) => s.panelOpen);
  const togglePanel = useFolderStore((s) => s.togglePanel);

  return (
    <HashRouter>
      <NavShortcuts />
      <div className="flex h-screen bg-background text-foreground">
        {/* Sidebar */}
        <nav className="flex flex-col w-16 shrink-0 border-r border-border bg-sidebar text-sidebar-foreground select-none">
          {/* Tool toggle — distinct color to separate it from the page nav below */}
          <button
            type="button"
            onClick={togglePanel}
            className={`flex flex-col items-center justify-center gap-0.5 h-14 text-[10px] transition-colors ${
              panelOpen
                ? 'text-sidebar-primary-foreground bg-sidebar-primary'
                : 'text-sidebar-primary hover:bg-sidebar-primary/10'
            }`}
            title="文件夹 (Cmd+B)"
          >
            <FolderTree className="size-4" />
            文件夹
          </button>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
              draggable={false}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center gap-0.5 h-14 text-[10px] transition-colors ${
                  isActive
                    ? 'text-sidebar-primary-foreground bg-sidebar-accent'
                    : 'text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent/50'
                }`
              }
            >
              <item.icon className="size-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {panelOpen && <FolderPanel />}

        {/* Main content */}
        <main className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<EditorPage />} />
            <Route path="/browser" element={<BrowserPage />} />
            <Route path="/trash" element={<TrashPage />} />
            <Route path="/reminders" element={<RemindersPage />} />
            <Route path="/todo" element={<TodoPage />} />
            <Route path="/ai" element={<AIPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
