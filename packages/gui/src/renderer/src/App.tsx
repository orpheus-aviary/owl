import { HashRouter, NavLink, Route, Routes } from 'react-router-dom';
import { AIPage } from './pages/AIPage';
import { BrowserPage } from './pages/BrowserPage';
import { EditorPage } from './pages/EditorPage';
import { RemindersPage } from './pages/RemindersPage';
import { SettingsPage } from './pages/SettingsPage';
import { TodoPage } from './pages/TodoPage';
import { TrashPage } from './pages/TrashPage';

const NAV_ITEMS = [
  { path: '/', label: '编辑', page: 'editor' },
  { path: '/browser', label: '浏览', page: 'browser' },
  { path: '/trash', label: '回收站', page: 'trash' },
  { path: '/reminders', label: '提醒', page: 'reminders' },
  { path: '/ai', label: 'AI', page: 'ai' },
  { path: '/todo', label: '待办', page: 'todo' },
  { path: '/settings', label: '设置', page: 'settings' },
] as const;

export function App() {
  return (
    <HashRouter>
      <div className="flex h-screen">
        {/* Sidebar */}
        <nav className="flex flex-col w-16 bg-zinc-900 text-zinc-400 border-r border-zinc-800">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                `flex items-center justify-center h-14 text-xs transition-colors hover:text-white ${
                  isActive ? 'text-white bg-zinc-800' : ''
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Main content */}
        <main className="flex-1 overflow-auto bg-zinc-950 text-zinc-100">
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
