import { AppRoutes } from '@/components/AppRoutes';
import { ClaimAccountDialog } from '@/components/ClaimAccountDialog';
import { DeleteConfirmDialog } from '@/components/DeleteConfirmDialog';
import { EventsSubscriber } from '@/components/EventsSubscriber';
import { FolderPanel } from '@/components/FolderPanel';
import { extractTitle } from '@/components/NoteListItem';
import { NoteNavGuardDialog } from '@/components/NoteNavGuardDialog';
import { SwitchUnsavedDialog } from '@/components/SwitchUnsavedDialog';
import { UnsavedTabsDialog } from '@/components/UnsavedTabsDialog';
import { ConflictDialog } from '@/components/ai/ConflictDialog';
import { NoteAppliedToast } from '@/components/ai/NoteAppliedToast';
import { VersionConflictDialog } from '@/components/editor/VersionConflictDialog';
import { MobileShell } from '@/components/mobile/MobileShell';
import { ConflictsNav } from '@/components/sync/ConflictsNav';
import { SyncStatusBar } from '@/components/sync/SyncStatusBar';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useOwlLayout } from '@/hooks/useOwlLayout';
import * as api from '@/lib/api';
import { type ShortcutsConfig, moveNoteToFolder } from '@/lib/api';
import { type DragData, isDragData, isDropTarget } from '@/lib/dnd-types';
import { LAYOUT_KEYS } from '@/lib/layout-keys';
import { matchesShortcut } from '@/lib/shortcuts';
import { getPlatform } from '@/platform';
import { activateSession } from '@/session/session-actions';
import { useConfigStore } from '@/stores/config-store';
import { useDataBus } from '@/stores/data-bus';
import { useEditorStore } from '@/stores/editor-store';
import { isDescendant, useFolderStore } from '@/stores/folder-store';
import { useNoteStore } from '@/stores/note-store';
import { currentGen, isStale } from '@/stores/session-epoch';
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  TouchSensor,
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
import { Group, Panel, usePanelRef } from 'react-resizable-panels';
import { HashRouter, NavLink, useNavigate } from 'react-router-dom';

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

/**
 * Build the ordered id list for a target folder (or unfiled when folderId=null)
 * from the current panelNotes snapshot. Respects current position-based order.
 *
 * @param folderId   Target scope; null = unfiled
 * @param draggedId  Note being dropped into the scope
 * @param insertIndex If defined, position where to insert draggedId (0 = top,
 *                    list.length = bottom). If undefined, draggedId is appended.
 */
function buildReorderList(
  folderId: string | null,
  draggedId: string,
  insertIndex?: number,
): string[] {
  // Panel notes arrive already sorted by position ASC NULLS LAST, updated_at DESC
  // (see folder-store.fetchPanelNotes with sort_by=position).
  const allPanelNotes = useFolderStore.getState().panelNotes;
  const scopeIds = allPanelNotes
    .filter((n) => (folderId == null ? n.folderId == null : n.folderId === folderId))
    .map((n) => n.id)
    .filter((id) => id !== draggedId);
  const idx = insertIndex ?? scopeIds.length;
  const clamped = Math.max(0, Math.min(idx, scopeIds.length));
  return [...scopeIds.slice(0, clamped), draggedId, ...scopeIds.slice(clamped)];
}

/**
 * Move a note into `targetFolderId` (when `doMove`) then reorder it into place.
 * NULL position would combine with the freshly-bumped updated_at to land the
 * note at the TOP of the NULL group, not the bottom — so we always reorder
 * explicitly. ③ (附录 A): `gen`-guarded after every await so a profile switch
 * mid-drop can't fetch panel notes / reorder against the NEW profile or write
 * an old note id into the new library.
 */
async function moveNoteAndReorder(
  gen: number,
  noteId: string,
  targetFolderId: string | null,
  insertIndex: number | undefined,
  doMove: boolean,
): Promise<void> {
  if (doMove) {
    const moved = await moveNoteToFolder(noteId, targetFolderId);
    if (isStale(gen)) return;
    // Pass the post-move updatedAt so a web tab rebases its CAS baseline (the
    // move bumped updated_at; the reorder below only touches position).
    useEditorStore.getState().syncTabFolderId(noteId, targetFolderId, moved.data?.updatedAt);
    // Refresh panelNotes so buildReorderList sees the note in its new scope.
    await useFolderStore.getState().fetchPanelNotes();
    if (isStale(gen)) return;
  }
  const ordered = buildReorderList(targetFolderId, noteId, insertIndex);
  await api.reorderNotes(targetFolderId, ordered);
  if (isStale(gen)) return;
  useDataBus.getState().bumpNotes();
}

async function handleNoteDrop(
  drag: Extract<DragData, { kind: 'note' }>,
  drop: import('@/lib/dnd-types').DropTarget,
): Promise<void> {
  const gen = currentGen();
  try {
    if (drop.kind === 'folder-node') {
      await moveNoteAndReorder(gen, drag.noteId, drop.folderId, undefined, true);
      return;
    }
    if (drop.kind === 'root-blank') {
      await moveNoteAndReorder(gen, drag.noteId, null, undefined, true);
      return;
    }
    if (drop.kind === 'note-gap') {
      // Move only when crossing folders; a same-folder gap drop just reorders.
      const src = useFolderStore.getState().panelNotes.find((n) => n.id === drag.noteId);
      const srcFolderId = src?.folderId ?? null;
      await moveNoteAndReorder(
        gen,
        drag.noteId,
        drop.folderId,
        drop.index,
        srcFolderId !== drop.folderId,
      );
      return;
    }
    // folder-gap — notes can't drop here
  } catch (err) {
    console.error('note drop failed', err);
  }
}

export function MainApp() {
  // ③: cold-start fetches (config + hydration, conflicts, notes, folder tree /
  // panel, sync status) now live in `bootstrapSession`, owned by
  // `SessionCoordinator` — the single awaitable entry the BootstrapOverlay
  // waits on. MainApp no longer fetches on mount; it renders from the stores
  // bootstrap fills and refreshes via data-bus.

  // A profile switch (login / logout) committed in main. ③: replace the old
  // `location.reload()` with in-app session isolation — reset every store,
  // remount the epoch-keyed session root (new SSE under the new profile), and
  // re-bootstrap. Defer one macrotask so the triggering sync:login/logout IPC
  // reply has fully settled before the swap runs.
  useEffect(() => {
    return getPlatform().sync.onProfileSwitched?.(() => {
      setTimeout(() => void activateSession(), 0);
    });
  }, []);

  // Stage 1 #5 — pick the shell by host + viewport. Electron is always desktop
  // (useIsMobile is a hard `false` there); the web host flips to the mobile
  // shell below 768px. Both shells render `<AppRoutes/>` in their content slot.
  const isMobile = useIsMobile();

  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  // DndContext is hoisted above the shell switch so drag semantics are shared.
  // MouseSensor drives desktop; TouchSensor needs a 200ms long-press so a tap /
  // scroll on a phone isn't hijacked into a drag (§5 — only the folder drawer's
  // dedicated handle opts into touch dragging; Browser rows never attach drag).
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

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
      <EventsSubscriber />
      <NavShortcuts />
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        {isMobile ? <MobileShell /> : <DesktopShell />}
        <DragOverlay modifiers={[snapCenterToCursor]} dropAnimation={null}>
          {activeDrag && <DragOverlayCard drag={activeDrag} />}
        </DragOverlay>
      </DndContext>
      <DeleteConfirmDialog />
      <NoteAppliedToast />
      <ConflictDialog />
      <VersionConflictDialog />
      <UnsavedTabsDialog />
      <SwitchUnsavedDialog />
      <NoteNavGuardDialog />
      <ClaimAccountDialog />
    </HashRouter>
  );
}

/**
 * Desktop shell — the 64px vertical nav + collapsible folder panel + resizable
 * main pane. Owns the folder-panel layout hooks (`panelOpen` / `usePanelRef` /
 * `useOwlLayout` + the collapse-sync effect) that used to live in MainApp; the
 * DOM is byte-identical to the pre-split desktop layout.
 */
function DesktopShell() {
  const panelOpen = useFolderStore((s) => s.panelOpen);
  const togglePanel = useFolderStore((s) => s.togglePanel);

  const folderPanelRef = usePanelRef();
  const folderLayout = useOwlLayout(LAYOUT_KEYS.folderLayout);

  // Sync imperative collapse state with the store-backed `panelOpen` flag so
  // Cmd+B / the sidebar button remain the source of truth. panelOpen itself
  // is persisted in localStorage, so the initial mount matches the user's
  // last explicit choice and the library's defaultLayout restores the width.
  useEffect(() => {
    const panel = folderPanelRef.current;
    if (!panel) return;
    if (panelOpen) panel.expand();
    else panel.collapse();
  }, [panelOpen, folderPanelRef]);

  return (
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

        {/* P5-c §6.19 — only renders when count > 0. */}
        <ConflictsNav />

        {/* P5-b §6.3 — daemon sync indicator pinned to the bottom of
         * the sidebar. The button must be a direct flex child of <nav>
         * so it stretches to the 64px column width; a wrapping div
         * would shrink it to content width and push the dot off-centre.
         * `mt-auto` on the button pushes it past Settings, gap between
         * scales with window height. */}
        <SyncStatusBar className="mt-auto" />
      </nav>

      <Group
        orientation="horizontal"
        id={LAYOUT_KEYS.folderLayout}
        defaultLayout={folderLayout.defaultLayout}
        onLayoutChanged={(layout) => {
          // Skip save when folder is collapsed (size 0) — otherwise Cmd+B
          // close would overwrite the user's saved width with zero.
          if ((layout.folder ?? 0) > 0) folderLayout.onLayoutChanged?.(layout);
        }}
        className="flex flex-1 min-w-0"
      >
        <Panel
          id="folder"
          panelRef={folderPanelRef}
          collapsible
          collapsedSize={0}
          defaultSize="20%"
          minSize="120px"
          className="h-full w-full min-h-0 min-w-0"
        >
          <FolderPanel />
        </Panel>
        <ResizeHandle disabled={!panelOpen} className={panelOpen ? '' : 'invisible'} />
        <Panel
          id="main"
          defaultSize="80%"
          minSize="400px"
          className="h-full w-full min-h-0 min-w-0"
        >
          <main className="h-full w-full overflow-hidden">
            <AppRoutes />
          </main>
        </Panel>
      </Group>
    </div>
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
  // VSCode-style: solid blue bg (sidebar-primary — owl theme's primary is
  // neutral white, so we borrow the sidebar accent), white text, compact pill
  // centered on cursor.
  return (
    <div className="pointer-events-none inline-flex w-fit items-center gap-1.5 rounded-sm bg-sidebar-primary px-2 py-0.5 text-[11px] text-sidebar-primary-foreground shadow-lg">
      <Icon className="size-3 shrink-0" />
      <span className="max-w-[120px] truncate">{label}</span>
    </div>
  );
}
