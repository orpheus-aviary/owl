import { AIPage } from '@/pages/AIPage';
import { BrowserPage } from '@/pages/BrowserPage';
import { ConflictsPage } from '@/pages/ConflictsPage';
import { EditorPage } from '@/pages/EditorPage';
import { FilesPage } from '@/pages/FilesPage';
import { RemindersPage } from '@/pages/RemindersPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { TodoPage } from '@/pages/TodoPage';
import { TrashPage } from '@/pages/TrashPage';
import { Route, Routes } from 'react-router-dom';

/**
 * Shared page router, mounted inside both the desktop and mobile shells'
 * content slots so the two shells stay in lockstep on routing.
 *
 * `/note/:noteId` is the mobile detail route (EditorPage renders one note; on
 * desktop the param is ignored and the tabbed editor renders as before). `/files`
 * is the mobile 「文件」page (folder tree); desktop keeps folders in its sidebar
 * and never routes there.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<EditorPage />} />
      <Route path="/note/:noteId" element={<EditorPage />} />
      <Route path="/files" element={<FilesPage />} />
      <Route path="/browser" element={<BrowserPage />} />
      <Route path="/trash" element={<TrashPage />} />
      <Route path="/reminders" element={<RemindersPage />} />
      <Route path="/todo" element={<TodoPage />} />
      <Route path="/ai" element={<AIPage />} />
      <Route path="/conflicts" element={<ConflictsPage />} />
      <Route path="/settings" element={<SettingsPage />} />
    </Routes>
  );
}
