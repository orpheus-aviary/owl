import { Button } from '@/components/ui/button';
import { useOpenNote } from '@/hooks/useOpenNote';
import { useActiveTab, useEditorStore } from '@/stores/editor-store';
import { isUnsaved } from '@/stores/editor-tabs';
import { type NavState, useNoteNavGuard } from '@/stores/note-nav-guard';
import { useNoteStore } from '@/stores/note-store';
import { ChevronLeft, Eye, Pencil, SquarePen } from 'lucide-react';
import { useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PAGE_TITLES } from './mobile-nav';

/** The note id embedded in a `/note/:id` pathname, or null on any other route. */
function detailNoteId(pathname: string): string | null {
  return pathname.startsWith('/note/') ? pathname.slice('/note/'.length) : null;
}

/** Routes where a 「新建笔记」action makes sense (the note-listing pages). The
 *  editor is a detail with no list; other list pages (提醒/待办) are read-only
 *  views over existing notes. */
const NEW_NOTE_ROUTES = new Set(['/browser', '/files']);

/**
 * Two-state top bar (§3.3 + revised nav model).
 *   - normal: the page title + a 新建笔记 button on the listing pages (folders
 *     live on their own 「文件」page now, so no ☰ drawer button).
 *   - detail (`/note/:id`): ← back + note title + edit⇄preview toggle + 保存.
 * Each list page carries its own search / filter / actions in-body.
 */
export function MobileTopBar() {
  const location = useLocation();
  if (location.pathname.startsWith('/note/')) return <DetailTopBar />;

  const title = PAGE_TITLES[location.pathname] ?? 'Owl';
  return (
    <header className="shrink-0 flex items-center h-12 px-3 border-b border-border bg-background">
      <span className="flex-1 truncate text-sm font-medium">{title}</span>
      {NEW_NOTE_ROUTES.has(location.pathname) && <NewNoteButton />}
    </header>
  );
}

/** Create a fresh note and open it (removing the mobile new-note gap left when
 *  the editor list — which used to carry the ＋ — became detail-only). */
function NewNoteButton() {
  const openNote = useOpenNote();
  const create = async () => {
    const note = await useNoteStore.getState().createNote();
    if (note) void openNote({ noteId: note.id });
  };
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-9"
      onClick={() => void create()}
      aria-label="新建笔记"
    >
      <SquarePen className="size-5" />
    </Button>
  );
}

function DetailTopBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = useActiveTab();
  const mobileMode = useEditorStore((s) => s.mobileMode);
  const setMobileMode = useEditorStore((s) => s.setMobileMode);
  // Live ref so the post-save fixup below reads the CURRENT route/state after
  // the await, not the closure captured when 保存 was tapped (§4.1.6 a).
  const locationRef = useRef(location);
  locationRef.current = location;

  const state = location.state as NavState | undefined;
  const back = () => {
    const doBack = () => {
      // §4.1.3: pop when we pushed onto this detail, else jump back to the source
      // page (replacing so the popped detail can't be re-reached with forward).
      if (state?.canPop) navigate(-1);
      else navigate(state?.returnTo ?? '/', { replace: true });
    };
    // Route through the guard: an unsaved note prompts 保存/放弃/继续编辑 before
    // leaving; a clean one goes back immediately (§ revised model). Hardware /
    // browser back can't be intercepted in HashRouter — the dirty tab just stays
    // in memory (UnsavedTabsDialog is the quit-time safety net).
    void useNoteNavGuard.getState().requestLeave(doBack);
  };

  const dirty = activeTab ? isUnsaved(activeTab) : false;
  const save = async () => {
    const id = useEditorStore.getState().activeTabId;
    if (!id) return;
    const original = detailNoteId(locationRef.current.pathname);
    const r = await useEditorStore.getState().requestSaveOrConflict(id);
    // Draft→real id: the URL still names the dead draft id → canonical-replace
    // to the real one, inheriting canPop/returnTo. Only when the save actually
    // succeeded AND the user is still on that same detail (they may have hit
    // back mid-save — read the LIVE location, not the pre-await closure). A
    // same-id save leaves the route correct, so it needs no navigation.
    if (!r.ok || !r.noteId) return;
    const stillHere = detailNoteId(locationRef.current.pathname) === original;
    if (stillHere && r.noteId !== original) {
      navigate(`/note/${r.noteId}`, { replace: true, state: locationRef.current.state });
    }
  };

  return (
    <header className="shrink-0 flex items-center gap-1 h-12 px-1 border-b border-border bg-background">
      <Button variant="ghost" size="icon" className="size-9" onClick={back} aria-label="返回">
        <ChevronLeft className="size-5" />
      </Button>
      <span className="flex-1 truncate text-sm font-medium">{activeTab?.title ?? '笔记'}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-9"
        onClick={() => setMobileMode(mobileMode === 'edit' ? 'preview' : 'edit')}
        aria-label={mobileMode === 'edit' ? '切换到预览' : '切换到编辑'}
      >
        {mobileMode === 'edit' ? <Eye className="size-5" /> : <Pencil className="size-5" />}
      </Button>
      {/* Dirty marker: the save button lights up (filled primary) only when there
          are unsaved changes; otherwise it's a greyed, un-clickable ghost. */}
      <Button
        variant={dirty ? 'default' : 'ghost'}
        size="sm"
        className="min-h-[36px]"
        onClick={() => void save()}
        disabled={!dirty}
      >
        保存
      </Button>
    </header>
  );
}
