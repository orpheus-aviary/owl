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
import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
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
  { path: '/ai', label: 'AI', icon: Bot },
  { path: '/todo', label: '待办', icon: CheckSquare },
  { path: '/settings', label: '设置', icon: Settings },
];

export function App() {
  return (
    <HashRouter>
      <div className="flex h-screen bg-background text-foreground">
        {/* Sidebar */}
        <nav className="flex flex-col w-16 shrink-0 border-r border-border bg-sidebar text-sidebar-foreground">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              end={item.path === '/'}
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
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<EditorPage />} />
            <Route path="/browser" element={<BrowserPage />} />
            <Route path="/trash" element={<TrashPage />} />
            <Route path="/reminders" element={<RemindersPage />} />
            <Route path="/ai" element={<AIPage />} />
            <Route path="/todo" element={<TodoPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
