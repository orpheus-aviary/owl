import { useOpenNote } from '@/hooks/useOpenNote';
import { useAiStore } from '@/stores/ai-store';
import type { NoteAppliedNotice } from '@/stores/ai-store';
import { useEditorStore } from '@/stores/editor-store';
import type { PrepareResult } from '@/stores/note-nav-guard';
import { CheckCircle2, X } from 'lucide-react';
import { useEffect } from 'react';

const AUTO_DISMISS_MS = 5000;
const PREVIEW_MAX = 60;

/**
 * Global toast lane for Tier-1 `note_applied` events. Mounted at app root
 * so notifications show up regardless of which page is active — the AI
 * may write to a note while the user is sitting on the editor, browser,
 * or todo page.
 *
 * Each notice auto-dismisses after {AUTO_DISMISS_MS}ms; clicking the
 * toast jumps to the edited tab (opening it if it isn't already open)
 * and dismisses. Close button × dismisses without navigating.
 */
export function NoteAppliedToast() {
  const notices = useAiStore((s) => s.noteAppliedNotices);
  if (notices.length === 0) return null;
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {notices.map((n) => (
        <ToastCard key={n.id} notice={n} />
      ))}
    </div>
  );
}

function ToastCard({ notice }: { notice: NoteAppliedNotice }) {
  const dismiss = useAiStore((s) => s.dismissNoteAppliedNotice);
  const openNote = useOpenNote();

  useEffect(() => {
    const timer = setTimeout(() => dismiss(notice.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [dismiss, notice.id]);

  const preview = truncate(notice.appendedText);

  const openInEditor = () => {
    // Fabricate the tab from the SSE payload inside `prepare` so no extra
    // round-trip is needed (mirrors the pre-contract behavior). On mobile the
    // guard then routes to /note/:id and EditorPage reuses this seeded tab.
    void openNote({
      noteId: notice.noteId,
      prepare: (): PrepareResult => {
        const editor = useEditorStore.getState();
        if (editor.tabs.some((t) => t.noteId === notice.noteId)) {
          editor.setActiveTab(notice.noteId);
        } else {
          editor.openNote({
            id: notice.noteId,
            content: notice.latestContent,
            tags: [],
            folderId: null,
            trashLevel: 0,
            createdAt: '',
            updatedAt: '',
            trashedAt: null,
            autoDeleteAt: null,
            deviceId: null,
            contentHash: null,
            pinnedAt: null,
            position: null,
          });
        }
        return 'ok';
      },
    }).then((outcome) => {
      if (outcome === 'opened') dismiss(notice.id);
    });
  };

  return (
    <div className="pointer-events-auto relative w-80 rounded-md border border-border bg-card text-card-foreground shadow-lg animate-in fade-in slide-in-from-top-2">
      <button
        type="button"
        onClick={openInEditor}
        className="flex items-start gap-2 p-3 pr-8 w-full text-left hover:bg-accent/50 rounded-md"
      >
        <CheckCircle2 className="size-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium">AI 已更新笔记</p>
          <p className="text-xs text-muted-foreground truncate">{notice.noteId}</p>
          {preview && (
            <p className="mt-1 text-xs text-foreground/80 line-clamp-2 break-words whitespace-pre-wrap">
              + {preview}
            </p>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={() => dismiss(notice.id)}
        className="absolute top-2 right-2 text-muted-foreground hover:text-foreground p-1 rounded"
        aria-label="关闭"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= PREVIEW_MAX) return collapsed;
  return `${collapsed.slice(0, PREVIEW_MAX)}…`;
}
