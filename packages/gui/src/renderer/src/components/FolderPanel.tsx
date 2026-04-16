import { useRequestDeleteNote } from '@/components/DeleteConfirmDialog';
import { extractTitle } from '@/components/NoteListItem';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Note } from '@/lib/api';
import type { DragData, DropTarget } from '@/lib/dnd-types';
import { cn } from '@/lib/utils';
import { openNoteById } from '@/stores/editor-store';
import {
  type FolderNode,
  buildFolderTree,
  isDescendant,
  useFolderStore,
} from '@/stores/folder-store';
import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileText,
  Folder,
  FolderPlus,
  Inbox,
  MoreHorizontal,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

/** What the renderer is currently editing in a tree row (new / rename). */
type EditingState =
  | { kind: 'none' }
  | { kind: 'create'; parentId: string | null }
  | { kind: 'rename'; folderId: string };

/** Shared props threaded through the recursive FolderRow tree. */
interface RowHandlers {
  expanded: Set<string>;
  editing: EditingState;
  notesByFolder: Map<string, Note[]>;
  selectedNoteId: string | null;
  onToggle: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  onRename: (folderId: string) => void;
  onDelete: (folderId: string, name: string) => void;
  onSubmit: (name: string) => void;
  onCancel: () => void;
  onSelectNote: (id: string) => void;
  onOpenNote: (id: string) => void;
  onDeleteNote: (id: string) => void;
}

export function FolderPanel() {
  const {
    folders,
    panelNotes,
    expanded,
    loading,
    error,
    fetch,
    fetchPanelNotes,
    toggleExpanded,
    expand,
    create,
    rename,
    remove,
  } = useFolderStore();
  const setExpandedState = useFolderStore.setState;
  const [editing, setEditing] = useState<EditingState>({ kind: 'none' });
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const navigate = useNavigate();
  const requestDelete = useRequestDeleteNote();

  useEffect(() => {
    void fetch();
    void fetchPanelNotes();
  }, [fetch, fetchPanelNotes]);

  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const allExpanded = folders.length > 0 && expanded.size >= folders.length;

  // Group notes by folder_id for inline display
  const { notesByFolder, rootNotes } = useMemo(() => {
    const map = new Map<string, Note[]>();
    const root: Note[] = [];
    for (const n of panelNotes) {
      if (!n.folderId) {
        root.push(n);
      } else {
        const arr = map.get(n.folderId) ?? [];
        arr.push(n);
        map.set(n.folderId, arr);
      }
    }
    return { notesByFolder: map, rootNotes: root };
  }, [panelNotes]);

  const [unfiledOpen, setUnfiledOpen] = useState(false);

  const toggleExpandAll = () => {
    if (allExpanded) {
      setExpandedState({ expanded: new Set() });
    } else {
      setExpandedState({ expanded: new Set(folders.map((f) => f.id)) });
    }
  };

  const handleCreate = (parentId: string | null) => {
    if (parentId) expand(parentId);
    setEditing({ kind: 'create', parentId });
  };
  const handleRename = (folderId: string) => setEditing({ kind: 'rename', folderId });
  const handleCancel = () => setEditing({ kind: 'none' });

  const handleSubmit = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setEditing({ kind: 'none' });
      return;
    }
    if (editing.kind === 'create') {
      await create(trimmed, editing.parentId);
    } else if (editing.kind === 'rename') {
      await rename(editing.folderId, trimmed);
    }
    setEditing({ kind: 'none' });
  };

  const handleDelete = async (folderId: string, name: string) => {
    const confirmed = window.confirm(
      `删除文件夹「${name}」？\n\n子文件夹会提升到父级，其中的笔记会变为未分类（不会被删除）。`,
    );
    if (!confirmed) return;
    await remove(folderId);
    await fetchPanelNotes();
  };

  const handleOpenNote = (noteId: string) => {
    openNoteById(noteId);
    navigate('/');
  };

  const handleDeleteNote = async (noteId: string) => {
    await requestDelete(noteId);
    setSelectedNoteId((prev) => (prev === noteId ? null : prev));
    await fetchPanelNotes();
  };

  const handlers: RowHandlers = {
    expanded,
    editing,
    notesByFolder,
    selectedNoteId,
    onToggle: toggleExpanded,
    onCreate: handleCreate,
    onRename: handleRename,
    onDelete: handleDelete,
    onSubmit: handleSubmit,
    onCancel: handleCancel,
    onSelectNote: setSelectedNoteId,
    onOpenNote: handleOpenNote,
    onDeleteNote: handleDeleteNote,
  };

  return (
    <aside
      className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground select-none"
      aria-label="文件夹面板"
    >
      <header className="flex items-center justify-between gap-1 px-3 h-10 border-b border-border text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>文件夹</span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title={allExpanded ? '全部折叠' : '全部展开'}
            onClick={toggleExpandAll}
          >
            {allExpanded ? (
              <ChevronsDownUp className="size-4" />
            ) : (
              <ChevronsUpDown className="size-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title="新建根级文件夹"
            onClick={() => handleCreate(null)}
          >
            <FolderPlus className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto py-1 text-sm">
        {error && <div className="px-3 py-2 text-destructive">{error}</div>}
        {loading && folders.length === 0 && (
          <div className="px-3 py-2 text-muted-foreground">加载中…</div>
        )}
        {!loading && tree.length === 0 && editing.kind !== 'create' && (
          <div className="px-3 py-2 text-muted-foreground">暂无文件夹</div>
        )}

        {/* Inline create-at-root input */}
        {editing.kind === 'create' && editing.parentId === null && (
          <div className="px-2 py-1">
            <FolderNameInput initial="" onSubmit={handleSubmit} onCancel={handleCancel} />
          </div>
        )}

        {tree.map((node, i) => (
          <Fragment key={node.id}>
            <DroppableGap id={`gap:root:${i}`} parentId={null} index={i} />
            <FolderRow node={node} depth={0} {...handlers} />
          </Fragment>
        ))}
        {tree.length > 0 && (
          <DroppableGap id={`gap:root:${tree.length}`} parentId={null} index={tree.length} />
        )}

        {/* Unfiled notes section — virtual folder at bottom showing folder_id=null notes */}
        {rootNotes.length > 0 && (
          <UnfiledSection
            notes={rootNotes}
            isOpen={unfiledOpen}
            onToggle={() => setUnfiledOpen((v) => !v)}
            selectedNoteId={selectedNoteId}
            onSelectNote={setSelectedNoteId}
            onOpenNote={handleOpenNote}
            onDeleteNote={handleDeleteNote}
          />
        )}
      </div>

      {/* Root drop zone lives outside the scroll area so it's always visible
          at the panel footer, regardless of how many folders exist. */}
      <RootBlankDrop />
    </aside>
  );
}

// ─── Drop zones ────────────────────────────────────────

/**
 * Returns true iff the current active drag would be rejected if dropped on a
 * folder node / gap at the given parent chain anchor. Used to suppress the
 * hover highlight when the drop would noop (self / cycle / already-child).
 */
function useInvalidFolderTarget(anchorId: string | null): boolean {
  const { active } = useDndContext();
  const folders = useFolderStore((s) => s.folders);
  const drag = active?.data.current as DragData | undefined;
  if (!drag || drag.kind !== 'folder') return false;
  if (anchorId === null) return false; // root target is always valid for a folder
  if (anchorId === drag.folderId) return true;
  return isDescendant(folders, drag.folderId, anchorId);
}

/** Thin 6px-tall drop zone between sibling folders. Shows a 2px highlighted
 *  horizontal rule when hovered, indicating "insert here". Suppresses the
 *  indicator when the drop would create a cycle. */
function DroppableGap({
  id,
  parentId,
  index,
}: {
  id: string;
  parentId: string | null;
  index: number;
}) {
  const data: DropTarget = { kind: 'folder-gap', parentId, index };
  const { setNodeRef, isOver } = useDroppable({ id, data });
  const invalid = useInvalidFolderTarget(parentId);
  const show = isOver && !invalid;
  return (
    <div ref={setNodeRef} className="relative h-1.5">
      {show && (
        <div className="absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-sidebar-primary" />
      )}
    </div>
  );
}

/** Dashed drop zone pinned to the panel footer (outside the scroll area).
 *  Only rendered while a drag is active, to avoid occupying space at rest.
 *  Dropping a folder here promotes it to top-level; dropping a note here
 *  clears its folder_id. */
function RootBlankDrop() {
  const { active } = useDndContext();
  const data: DropTarget = { kind: 'root-blank' };
  const { setNodeRef, isOver } = useDroppable({ id: 'drop:root-blank', data });
  if (!active) return null;
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'shrink-0 mx-2 mb-2 mt-1 rounded-md border border-dashed py-2 text-center text-[10px] transition-colors',
        isOver
          ? 'border-sidebar-primary bg-sidebar-primary/10 text-sidebar-primary'
          : 'border-border/50 text-muted-foreground/40',
      )}
    >
      移动到根目录
    </div>
  );
}

// ─── Unfiled notes section ─────────────────────────────

function UnfiledSection({
  notes,
  isOpen,
  onToggle,
  selectedNoteId,
  onSelectNote,
  onOpenNote,
  onDeleteNote,
}: {
  notes: Note[];
  isOpen: boolean;
  onToggle: () => void;
  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onOpenNote: (id: string) => void;
  onDeleteNote: (id: string) => void;
}) {
  return (
    <div className="mt-1 border-t border-border/50 pt-1">
      <button
        type="button"
        onClick={onToggle}
        className="group flex items-center gap-1 pr-1 h-7 rounded-sm hover:bg-sidebar-accent/60 cursor-default w-full"
        style={{ paddingLeft: 4 }}
      >
        <span className="size-4 shrink-0 flex items-center justify-center text-muted-foreground">
          {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        </span>
        <Inbox className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate text-xs text-muted-foreground text-left">
          未分类
          <span className="ml-1 text-[10px]">({notes.length})</span>
        </span>
      </button>
      {isOpen &&
        notes.map((note) => (
          <FolderNoteRow
            key={note.id}
            note={note}
            depth={1}
            isSelected={selectedNoteId === note.id}
            onSelect={onSelectNote}
            onOpen={onOpenNote}
            onDelete={onDeleteNote}
          />
        ))}
    </div>
  );
}

// ─── Recursive row ─────────────────────────────────────

function FolderRow({ node, depth, ...h }: { node: FolderNode; depth: number } & RowHandlers) {
  const isRenaming = h.editing.kind === 'rename' && h.editing.folderId === node.id;
  const isOpen = h.expanded.has(node.id);
  const folderNotes = h.notesByFolder.get(node.id) ?? [];
  const hasChildren = node.children.length > 0 || folderNotes.length > 0;
  const indent = depth * 12 + 4;

  const dragData: DragData = {
    kind: 'folder',
    folderId: node.id,
    parentId: node.parent_id,
  };
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: `folder:${node.id}`, data: dragData });

  const nodeDropData: DropTarget = { kind: 'folder-node', folderId: node.id };
  const { setNodeRef: setNodeDropRef, isOver: nodeIsOver } = useDroppable({
    id: `node:${node.id}`,
    data: nodeDropData,
  });
  // Suppress hover highlight when dropping here would be rejected
  // (self or descendant of the active folder drag).
  const invalidTarget = useInvalidFolderTarget(node.id);
  const showNodeHover = nodeIsOver && !invalidTarget;

  // Merge drag + drop refs onto the same element
  const setRowRef = (el: HTMLDivElement | null) => {
    setDragRef(el);
    setNodeDropRef(el);
  };

  // Rename takes over the row so the input stretches across the full width.
  if (isRenaming) {
    return (
      <div>
        <div className="px-2 py-1" style={{ paddingLeft: indent }}>
          <FolderNameInput initial={node.name} onSubmit={h.onSubmit} onCancel={h.onCancel} />
        </div>
        {isOpen && <ChildrenBlock node={node} depth={depth} folderNotes={folderNotes} h={h} />}
      </div>
    );
  }

  const isCreatingChildHere = h.editing.kind === 'create' && h.editing.parentId === node.id;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={setRowRef}
            {...listeners}
            {...attributes}
            onDoubleClick={() => hasChildren && h.onToggle(node.id)}
            className={cn(
              'group flex items-center gap-1 pr-1 h-7 rounded-sm',
              isDragging && 'opacity-40',
              showNodeHover
                ? 'bg-sidebar-primary/25 outline outline-2 outline-sidebar-primary'
                : 'hover:bg-sidebar-accent/60',
            )}
            style={{ paddingLeft: indent }}
          >
            <button
              type="button"
              className="size-4 shrink-0 flex items-center justify-center text-muted-foreground"
              onClick={() => h.onToggle(node.id)}
              aria-label={isOpen ? '折叠' : '展开'}
            >
              {hasChildren ? (
                isOpen ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )
              ) : null}
            </button>
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-xs">{node.name}</span>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
                  title="更多操作"
                >
                  <MoreHorizontal className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                // Prevent radix from stealing focus back to the trigger after close —
                // lets the inline create/rename input keep the cursor.
                onCloseAutoFocus={(e) => e.preventDefault()}
              >
                <DropdownMenuItem onClick={() => h.onCreate(node.id)}>
                  新建子文件夹
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => h.onRename(node.id)}>重命名</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => h.onDelete(node.id, node.name)}
                >
                  删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        {/* Right-click menu — radix ContextMenu anchors to the cursor position,
            unlike DropdownMenu which anchors to its trigger element. */}
        <ContextMenuContent onCloseAutoFocus={(e) => e.preventDefault()}>
          <ContextMenuItem onClick={() => h.onCreate(node.id)}>新建子文件夹</ContextMenuItem>
          <ContextMenuItem onClick={() => h.onRename(node.id)}>重命名</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => h.onDelete(node.id, node.name)}>
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {isCreatingChildHere && (
        <div className="px-2 py-1" style={{ paddingLeft: indent + 16 }}>
          <FolderNameInput initial="" onSubmit={h.onSubmit} onCancel={h.onCancel} />
        </div>
      )}

      {isOpen && <ChildrenBlock node={node} depth={depth} folderNotes={folderNotes} h={h} />}
    </div>
  );
}

/** Renders child folders + inline notes for an expanded folder. */
function ChildrenBlock({
  node,
  depth,
  folderNotes,
  h,
}: {
  node: FolderNode;
  depth: number;
  folderNotes: Note[];
  h: RowHandlers;
}) {
  return (
    <div>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          <DroppableGap id={`gap:${node.id}:${i}`} parentId={node.id} index={i} />
          <FolderRow node={child} depth={depth + 1} {...h} />
        </Fragment>
      ))}
      {node.children.length > 0 && (
        <DroppableGap
          id={`gap:${node.id}:${node.children.length}`}
          parentId={node.id}
          index={node.children.length}
        />
      )}
      {folderNotes.map((note) => (
        <FolderNoteRow
          key={note.id}
          note={note}
          depth={depth + 1}
          isSelected={h.selectedNoteId === note.id}
          onSelect={h.onSelectNote}
          onOpen={h.onOpenNote}
          onDelete={h.onDeleteNote}
        />
      ))}
    </div>
  );
}

// ─── Note row inside folder tree ──────────────────────

function FolderNoteRow({
  note,
  depth,
  isSelected,
  onSelect,
  onOpen,
  onDelete,
}: {
  note: Note;
  depth: number;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const title = extractTitle(note.content);
  const indent = depth * 12 + 4;
  const dragData: DragData = { kind: 'note', noteId: note.id };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `panel-note:${note.id}`,
    data: dragData,
  });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          {...listeners}
          {...attributes}
          onClick={() => onSelect(note.id)}
          onDoubleClick={() => onOpen(note.id)}
          className={cn(
            'group flex items-center gap-1 pr-1 h-7 rounded-sm cursor-default',
            isDragging && 'opacity-40',
            isSelected ? 'bg-accent' : 'hover:bg-sidebar-accent/60',
          )}
          style={{ paddingLeft: indent }}
        >
          {/* Spacer matching the chevron column */}
          <div className="size-4 shrink-0" />
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate text-xs">{title}</span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={() => onDelete(note.id)}>
          删除
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ─── Inline name input (rename + create) ───────────────

function FolderNameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Defer one frame so radix's focus-return from `onCloseAutoFocus` (even
    // when we preventDefault it) doesn't race with our focus call.
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onSubmit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onSubmit(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      placeholder="文件夹名"
      className="w-full bg-background border border-border rounded-sm px-1.5 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
    />
  );
}
