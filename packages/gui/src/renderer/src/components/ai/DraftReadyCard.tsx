import type { DraftReadyCard as DraftReadyData } from '@/stores/ai-store';
import {
  AlertCircle,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  FileEdit,
  FilePlus2,
  FolderClosed,
  Loader2,
} from 'lucide-react';
import { useEffect, useState } from 'react';

interface DraftReadyCardProps {
  draft: DraftReadyData;
  /** Hand the draft to the editor for staging + ConflictDialog flow. */
  onOpen?: (draft: DraftReadyData) => void;
  /** Tier-1 auto-merge: write directly via the daemon, no editor tab. */
  onApprove?: (draft: DraftReadyData) => void | Promise<void>;
}

const ACTION_LABELS: Record<DraftReadyData['action'], string> = {
  create: '新建笔记',
  update: '更新笔记',
  create_reminder: '新建提醒',
};

const ACTION_ICONS: Record<DraftReadyData['action'], typeof FilePlus2> = {
  create: FilePlus2,
  update: FileEdit,
  create_reminder: Bell,
};

const TITLE_FALLBACK = '(无标题)';
const PREVIEW_LIMIT = 200;

/**
 * Card the AI emits when it drafts a note (Tier-2 write). Two-button UX:
 *
 *   - 同意 (Tier-1): writes directly via the daemon REST API. Fastest path
 *     when the user trusts the AI's judgment; reuses the auto-merge toast
 *     so it feels identical to daemon-side `append_memo`.
 *   - 打开 (Tier-2): hands the draft to the editor for staged review +
 *     ConflictDialog when the user wants to inspect / edit before saving.
 *
 * Default expanded; auto-collapses after open / approve / merge so a
 * stack of approved cards doesn't hog vertical space. Conflicts (note
 * edited externally since the AI drafted) leave the card expanded with
 * a red error band so the user can fall back to "打开" for explicit
 * resolution.
 */
export function DraftReadyCard({ draft, onOpen, onApprove }: DraftReadyCardProps) {
  const Icon = ACTION_ICONS[draft.action];
  const title = extractTitle(draft.content);
  const preview =
    draft.content.length > PREVIEW_LIMIT
      ? `${draft.content.slice(0, PREVIEW_LIMIT)}…`
      : draft.content;

  // Local UI state — collapse the body after a successful open / approve;
  // when error or in-flight, force expanded so the user sees what's wrong.
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (draft.opened || draft.approved) setOpen(false);
  }, [draft.opened, draft.approved]);
  const isOpen = draft.error ? true : open;

  const disabled = draft.opened || draft.approved || draft.approving;
  const statusBadge = (() => {
    if (draft.approved) return '已同意';
    if (draft.opened) return '已打开';
    return null;
  })();

  return (
    <div className="rounded-md border border-border bg-background overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30 text-xs hover:bg-muted/50"
      >
        {isOpen ? (
          <ChevronDown className="size-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-3 text-muted-foreground shrink-0" />
        )}
        <Icon className="size-3.5 shrink-0 text-blue-500" />
        <span className="font-medium">{ACTION_LABELS[draft.action]}</span>
        <span className="text-muted-foreground truncate">· {title}</span>
        {statusBadge && (
          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
            {statusBadge}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="px-3 py-2 space-y-2">
          {draft.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {draft.tags.map((t) => (
                <span
                  key={t}
                  className="px-1.5 py-0.5 rounded text-[10px] bg-muted text-muted-foreground font-mono"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
          {draft.folder_id && (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <FolderClosed className="size-3" />
              <span className="font-mono">{draft.folder_id}</span>
            </div>
          )}
          <pre className="whitespace-pre-wrap break-words text-[11px] leading-snug text-muted-foreground bg-muted/20 rounded p-2 max-h-40 overflow-y-auto">
            {preview || '(无内容)'}
          </pre>

          {draft.error && (
            <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
              <span className="flex-1">{draft.error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => onApprove?.(draft)}
              disabled={!onApprove || disabled}
              className="text-xs px-2.5 py-1 rounded border border-border bg-background hover:bg-muted disabled:bg-muted/40 disabled:text-muted-foreground inline-flex items-center gap-1"
            >
              {draft.approving ? (
                <Loader2 className="size-3 animate-spin" />
              ) : draft.approved ? (
                <Check className="size-3" />
              ) : null}
              {draft.error ? '重试同意' : '同意'}
            </button>
            <button
              type="button"
              onClick={() => onOpen?.(draft)}
              disabled={!onOpen || disabled}
              className="text-xs px-2.5 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
            >
              {draft.opened ? '已打开' : '打开'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function extractTitle(content: string): string {
  const heading = content.match(/^#\s+(.+)/m);
  if (heading) return heading[1].trim();
  const firstLine = content.split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 40) ?? TITLE_FALLBACK;
}
