import type { DraftReadyCard as DraftReadyData } from '@/stores/ai-store';
import { Bell, FileEdit, FilePlus2, FolderClosed } from 'lucide-react';

interface DraftReadyCardProps {
  draft: DraftReadyData;
  /**
   * Click handler for the "open" button. Wired to
   * `editorStore.openAiDraft` / `stageAiUpdate` in step 7. Step 5 just
   * renders the card; passing `undefined` disables the button so we can
   * see the layout before any editor side-effects exist.
   */
  onOpen?: (draft: DraftReadyData) => void;
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
 * Card the AI emits when it drafts a note (Tier-2 write). Renders the
 * action, a derived title from the markdown body, the requested tags,
 * and the target folder. The "open" button hands the draft off to the
 * editor — the user reviews and saves there, the daemon never sees the
 * write until that save fires.
 */
export function DraftReadyCard({ draft, onOpen }: DraftReadyCardProps) {
  const Icon = ACTION_ICONS[draft.action];
  const title = extractTitle(draft.content);
  const preview =
    draft.content.length > PREVIEW_LIMIT
      ? `${draft.content.slice(0, PREVIEW_LIMIT)}…`
      : draft.content;

  return (
    <div className="rounded-md border border-border bg-background overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/30 text-xs">
        <Icon className="size-3.5 shrink-0 text-blue-500" />
        <span className="font-medium">{ACTION_LABELS[draft.action]}</span>
        <span className="text-muted-foreground truncate">· {title}</span>
      </div>
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
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={() => onOpen?.(draft)}
            disabled={!onOpen || draft.opened}
            className="text-xs px-2.5 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
          >
            {draft.opened ? '已打开' : '打开'}
          </button>
        </div>
      </div>
    </div>
  );
}

function extractTitle(content: string): string {
  const heading = content.match(/^#\s+(.+)/m);
  if (heading) return heading[1].trim();
  const firstLine = content.split('\n').find((l) => l.trim());
  return firstLine?.trim().slice(0, 40) ?? TITLE_FALLBACK;
}
