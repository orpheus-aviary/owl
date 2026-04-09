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
import { useEffect } from 'react';
import { HashRouter, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { AIPage } from './pages/AIPage';
import { BrowserPage } from './pages/BrowserPage';
import { EditorPage } from './pages/EditorPage';
import { RemindersPage } from './pages/RemindersPage';
import { SettingsPage } from './pages/SettingsPage';
import { TodoPage } from './pages/TodoPage';
import { TrashPage } from './pages/TrashPage';

const NAV_ITEMS: { path: string; label: string; icon: LucideIcon }[] = [
  { path: '/', label: '编辑', icon: PenSquare },
  { path: '/browser', label: '浏览', icon: Search },
  { path: '/trash', label: '回收站', icon: Trash2 },
  { path: '/reminders', label: '提醒', icon: Bell },
  { path: '/todo', label: '待办', icon: CheckSquare },
  { path: '/ai', label: 'AI', icon: Bot },
  { path: '/settings', label: '设置', icon: Settings },
];

function NavShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      const index = Number(e.key);
      if (index >= 1 && index <= NAV_ITEMS.length) {
        e.preventDefault();
        navigate(NAV_ITEMS[index - 1].path);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  return null;
}

export function App() {
  return (
    <HashRouter>
      <NavShortcuts />
      <div className="flex h-screen bg-background text-foreground">
        {/* Sidebar */}
        <nav className="flex flex-col w-16 shrink-0 border-r border-border bg-sidebar text-sidebar-foreground select-none">
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
