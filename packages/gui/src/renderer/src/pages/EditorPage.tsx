import { EditorPanel } from '@/components/EditorPanel';
import { NoteList } from '@/components/NoteList';
import { TabBar } from '@/components/TabBar';
import { type UnsavedAction, UnsavedDialog } from '@/components/UnsavedDialog';
import { Button } from '@/components/ui/button';
import { ResizeHandle } from '@/components/ui/resize-handle';
import { useEditorShortcuts } from '@/hooks/useEditorShortcuts';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useOpenNote } from '@/hooks/useOpenNote';
import { useOwlLayout } from '@/hooks/useOwlLayout';
import type { Note } from '@/lib/api';
import { LAYOUT_KEYS } from '@/lib/layout-keys';
import type { ResolveOutcome } from '@/stores/editor-store';
import { forgetDraftAlias, resolveOpen, useEditorStore } from '@/stores/editor-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Group, Panel } from 'react-resizable-panels';
import {
  Navigate,
  type NavigateFunction,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';

/**
 * The editor page renders in two shapes (§4.1 + revised model):
 *   - Desktop (Electron, or web ≥768px) → the tabbed editor, unchanged.
 *   - Mobile detail (`/note/:id`)        → one note, full width.
 * Mobile has no editor "home" — the editor is only reached by tapping a note
 * (from 浏览 / 文件 / AI …), so a bare mobile `/` redirects to the browse list.
 * `useIsMobile` is a hard `false` on Electron, so `<DesktopEditor/>` is
 * byte-identical to the pre-Step-5 page there.
 */
export function EditorPage() {
  const isMobile = useIsMobile();
  const { noteId } = useParams();
  if (!isMobile) return <DesktopEditor />;
  if (!noteId) return <Navigate to="/browser" replace />;
  return <MobileEditorDetail noteId={noteId} />;
}

function DesktopEditor() {
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false);
  const pendingCloseId = useRef<string | null>(null);
  const pendingCloseTitle = useRef('');

  const layout = useOwlLayout(LAYOUT_KEYS.editorLayout);

  const requestCloseTab = useCallback((noteId: string) => {
    const tab = useEditorStore.getState().tabs.find((t) => t.noteId === noteId);
    if (!tab) return;
    if (tab.dirty) {
      pendingCloseId.current = noteId;
      pendingCloseTitle.current = tab.title;
      setUnsavedDialogOpen(true);
    } else {
      useEditorStore.getState().closeTab(noteId);
    }
  }, []);

  const handleUnsavedAction = useCallback(async (action: UnsavedAction) => {
    const noteId = pendingCloseId.current;
    setUnsavedDialogOpen(false);
    if (!noteId) return;

    if (action === 'save') {
      const result = await useEditorStore.getState().saveNote(noteId);
      // Close the CURRENT id — a draft's id changed to its real id on create,
      // so closing the original `noteId` would leave the saved tab dangling.
      if (result.ok) useEditorStore.getState().closeTab(result.noteId ?? noteId);
    } else if (action === 'discard') {
      useEditorStore.getState().closeTab(noteId);
    }
    // 'cancel' — do nothing
    pendingCloseId.current = null;
  }, []);

  // NoteList hands over the fully-loaded `Note` (already in `useNoteStore`)
  // so we open synchronously — no `openNoteById` fetch that could race a
  // rapid click sequence and drop the user on a stale preview. opts decide
  // preview vs pinned tab (P3.4-e).
  const handleSelectNote = useCallback((note: Note, opts?: { preview?: boolean }) => {
    useEditorStore.getState().openNote(note, opts);
  }, []);

  // Cmd+N routes through the opener (desktop: open tab + navigate('/')).
  const openNote = useOpenNote();
  useEditorShortcuts({ requestCloseTab, openNote });

  return (
    <>
      <Group
        orientation="horizontal"
        id={LAYOUT_KEYS.editorLayout}
        defaultLayout={layout.defaultLayout}
        onLayoutChanged={layout.onLayoutChanged}
        className="flex h-full min-h-0"
      >
        <Panel
          id="note-list"
          defaultSize="22%"
          minSize="120px"
          className="h-full w-full min-h-0 min-w-0 border-r border-border"
        >
          <NoteList activeNoteId={activeTabId} onSelectNote={handleSelectNote} />
        </Panel>
        <ResizeHandle />
        <Panel
          id="editor-area"
          defaultSize="78%"
          minSize="400px"
          className="flex h-full w-full min-h-0 min-w-0 flex-col"
        >
          <TabBar onCloseTab={requestCloseTab} />
          <EditorPanel />
        </Panel>
      </Group>
      <UnsavedDialog
        open={unsavedDialogOpen}
        title={pendingCloseTitle.current}
        onAction={handleUnsavedAction}
      />
    </>
  );
}

type DetailStatus = 'loading' | 'ready' | 'not-found' | 'load-failed';

/**
 * Commit a `resolveOpen` outcome to the detail view. Only `aliased` navigates
 * (canonical-replace a stale `draft_*` URL to its real id, then drop the
 * single-use alias); `stale` is a deliberate no-op — the epoch-keyed session
 * root remounts. Pulled out of the effect so its `.then` callback stays under
 * the cognitive-complexity cap.
 */
function commitResolveOutcome(
  r: ResolveOutcome,
  ctx: {
    noteId: string;
    setStatus: (s: DetailStatus) => void;
    navigate: NavigateFunction;
    stateOf: () => unknown;
  },
): void {
  switch (r.kind) {
    case 'opened':
      ctx.setStatus('ready');
      return;
    case 'not-found':
      ctx.setStatus('not-found');
      return;
    case 'load-failed':
      ctx.setStatus('load-failed');
      return;
    case 'aliased':
      forgetDraftAlias(ctx.noteId);
      ctx.navigate(`/note/${r.realId}`, { replace: true, state: ctx.stateOf() });
      return;
    // 'stale' → leave the loader up.
  }
}

/**
 * Mobile detail (`/note/:id`): resolves the route param into the store and
 * renders one note full width. The open effect (§4.1.1) is race-hardened:
 *   - `requestToken` bumps on every run AND on cleanup, so a superseded resolve
 *     (noteId change / unmount / session switch) never commits — the gate is the
 *     token, not a stale closure comparison.
 *   - `retryNonce` re-runs the resolve for the load-failed「重试」button.
 * `resolveOpen` returns a discriminated outcome; only `aliased` navigates here
 * (canonical-replace a stale `draft_*` URL to its real id, then drop the alias).
 */
function MobileEditorDetail({ noteId }: { noteId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  // Live ref so the alias-replace below reads the CURRENT history state after
  // the resolve await, not the closure captured when the effect started.
  const locationRef = useRef(location);
  locationRef.current = location;

  const [status, setStatus] = useState<DetailStatus>('loading');
  const [retryNonce, setRetryNonce] = useState(0);
  const requestToken = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryNonce is a manual re-run trigger for the load-failed 重试 button.
  useEffect(() => {
    const token = ++requestToken.current;
    let cancelled = false;
    setStatus('loading');
    void resolveOpen(noteId).then((r) => {
      if (cancelled || token !== requestToken.current) return; // sole commit gate
      commitResolveOutcome(r, {
        noteId,
        setStatus,
        navigate,
        stateOf: () => locationRef.current.state,
      });
    });
    return () => {
      cancelled = true;
      requestToken.current++;
    };
  }, [noteId, retryNonce, navigate]);

  if (status === 'ready') return <EditorPanel />;
  if (status === 'not-found') {
    return <DetailPlaceholder>笔记不存在或已被删除。</DetailPlaceholder>;
  }
  if (status === 'load-failed') {
    return (
      <DetailPlaceholder>
        <p>加载失败。</p>
        <Button variant="outline" size="sm" onClick={() => setRetryNonce((n) => n + 1)}>
          重试
        </Button>
      </DetailPlaceholder>
    );
  }
  return <DetailPlaceholder>加载中…</DetailPlaceholder>;
}

function DetailPlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
