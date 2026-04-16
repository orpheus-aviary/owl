import { DeleteConfirmDialog } from '@/components/DeleteConfirmDialog';
import { FolderPanel } from '@/components/FolderPanel';
import { extractTitle } from '@/components/NoteListItem';
import { type ShortcutsConfig, moveNoteToFolder } from '@/lib/api';
import { type DragData, isDragData, isDropTarget } from '@/lib/dnd-types';
import { matchesShortcut } from '@/lib/shortcuts';
import { useBrowserStore } from '@/stores/browser-store';
import { useConfigStore } from '@/stores/config-store';
import { useEditorStore } from '@/stores/editor-store';
import { isDescendant, useFolderStore } from '@/stores/folder-store';
import { useNoteStore } from '@/stores/note-store';
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { snapCenterToCursor } from '@dnd-kit/modifiers';
import {
  Bell,
  Bot,
  CheckSquare,
  FileText,
  FolderTree,
  type LucideIcon,
  PenSquare,
  Search,
  Settings,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
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

async function handleFolderDrop(
  drag: Extract<DragData, { kind: 'folder' }>,
  drop: import('@/lib/dnd-types').DropTarget,
): Promise<void> {
  const folderStore = useFolderStore.getState();
  const { folderId, parentId: srcParent } = drag;

  if (drop.kind === 'folder-node') {
    if (drop.folderId === folderId) return; // self
    if (isDescendant(folderStore.folders, folderId, drop.folderId)) return; // cycle
    if (srcParent === drop.folderId) return; // already child
    await folderStore.move(folderId, drop.folderId);
    return;
  }

  if (drop.kind === 'folder-gap') {
    await handleFolderGap(folderId, drop.parentId, drop.index);
    return;
  }

  if (drop.kind === 'root-blank' && srcParent !== null) {
    await folderStore.move(folderId, null);
  }
}

async function handleFolderGap(
  folderId: string,
  targetParent: string | null,
  targetIndex: number,
): Promise<void> {
  const folderStore = useFolderStore.getState();
  // Cannot drop into own descendant (including self-as-parent)
  if (targetParent === folderId) return;
  if (targetParent && isDescendant(folderStore.folders, folderId, targetParent)) return;

  // Build new sibling list at the target parent (exclude the dragged folder
  // from its old slot before inserting at the drop index).
  const dragged = folderStore.folders.find((f) => f.id === folderId);
  if (!dragged) return;
  const siblings = folderStore.folders
    .filter((f) => f.parent_id === targetParent && f.id !== folderId)
    .sort((a, b) => a.position - b.position);
  siblings.splice(targetIndex, 0, { ...dragged, parent_id: targetParent });
  const items = siblings.map((f, i) => ({
    id: f.id,
    parent_id: targetParent,
    position: i,
  }));
  await folderStore.reorder(items);
}

async function handleNoteDrop(
  drag: Extract<DragData, { kind: 'note' }>,
  drop: import('@/lib/dnd-types').DropTarget,
): Promise<void> {
  let targetFolderId: string | null;
  if (drop.kind === 'folder-node') targetFolderId = drop.folderId;
  else if (drop.kind === 'root-blank') targetFolderId = null;
  else return; // gaps not a valid target for notes

  try {
    await moveNoteToFolder(drag.noteId, targetFolderId);
    useEditorStore.getState().syncTabFolderId(drag.noteId, targetFolderId);
    useNoteStore.getState().fetchNotes();
    useFolderStore.getState().fetchPanelNotes();
  } catch (err) {
    console.error('note move failed', err);
  }
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

  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current;
    if (isDragData(data)) setActiveDrag(data);
  };

  const onDragEnd = async (e: DragEndEvent) => {
    setActiveDrag(null);
    const drag = e.active.data.current;
    const drop = e.over?.data.current;
    if (!isDragData(drag) || !drop || !isDropTarget(drop)) return;
    if (drag.kind === 'folder') await handleFolderDrop(drag, drop);
    else await handleNoteDrop(drag, drop);
  };

  return (
    <HashRouter>
      <NavShortcuts />
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
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
        <DragOverlay modifiers={[snapCenterToCursor]} dropAnimation={null}>
          {activeDrag && <DragOverlayCard drag={activeDrag} />}
        </DragOverlay>
      </DndContext>
      <DeleteConfirmDialog />
    </HashRouter>
  );
}

function DragOverlayCard({ drag }: { drag: DragData }) {
  const folders = useFolderStore((s) => s.folders);
  const notes = useNoteStore((s) => s.notes);
  let label = '';
  let Icon: LucideIcon = FolderTree;
  if (drag.kind === 'folder') {
    label = folders.find((f) => f.id === drag.folderId)?.name ?? '文件夹';
  } else {
    const note = notes.find((n) => n.id === drag.noteId);
    label = note ? extractTitle(note.content) : '笔记';
    Icon = FileText;
  }
  // VSCode-style: solid blue bg (sidebar-primary — owl-ts theme's primary is
  // neutral white, so we borrow the sidebar accent), white text, compact pill
  // centered on cursor.
  return (
    <div className="pointer-events-none inline-flex w-fit items-center gap-1.5 rounded-sm bg-sidebar-primary px-2 py-0.5 text-[11px] text-sidebar-primary-foreground shadow-lg">
      <Icon className="size-3 shrink-0" />
      <span className="max-w-[120px] truncate">{label}</span>
    </div>
  );
}
