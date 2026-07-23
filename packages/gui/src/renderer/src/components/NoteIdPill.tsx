import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useOpenNote } from '@/hooks/useOpenNote';
import { type NoteMeta, fetchNoteMeta, noteMetaCacheGet } from '@/lib/note-id-refs';
import { cn } from '@/lib/utils';
import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

const LABEL_MAX = 20;

/**
 * Inline link-style pill that replaces a note UUID inside an assistant
 * markdown message. Four states:
 *   - loading: short id prefix, faint blue + pulse
 *   - ok:      real title, blue underlined, left-click → editor
 *   - trashed: title with line-through, click disabled
 *   - missing: `{short-id…}`, greyed, tooltip "笔记不存在"
 *
 * Title is fetched lazily through `fetchNoteMeta`; the module-level LRU
 * shares results across all mounted pills for the same id.
 */
export function NoteIdPill({ id }: { id: string }) {
  const openNote = useOpenNote();
  const [meta, setMeta] = useState<NoteMeta>(() => noteMetaCacheGet(id) ?? { status: 'loading' });

  useEffect(() => {
    if (meta.status !== 'loading') return;
    let cancelled = false;
    fetchNoteMeta(id)
      .then((m) => {
        if (!cancelled) setMeta(m);
      })
      .catch((err) => {
        // Non-404 failure — fetchNoteMeta doesn't cache these. Stay in
        // loading; a remount retries. Log to avoid unhandled rejection.
        console.warn('[note-id-pill] fetch failed', id, err);
      });
    return () => {
      cancelled = true;
    };
  }, [id, meta.status]);

  const handleClick = async (e: React.MouseEvent) => {
    if (meta.status !== 'ok') return;
    e.stopPropagation();
    // Desktop = openNoteById + navigate('/'); mobile routes to /note/:id. The
    // opener never rejects (it maps failures to a 'failed' outcome internally).
    await openNote({ noteId: id });
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(id);
    } catch (err) {
      console.warn('[note-id-pill] clipboard write failed', err);
    }
  };

  const label = renderLabel(meta, id);
  const interactive = meta.status === 'ok';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span
          role={interactive ? 'button' : undefined}
          tabIndex={interactive ? 0 : undefined}
          onClick={interactive ? handleClick : undefined}
          onKeyDown={
            interactive
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    void handleClick(e as unknown as React.MouseEvent);
                  }
                }
              : undefined
          }
          title={tooltipFor(meta)}
          className={cn(
            // Inline link look — matches `.markdown-preview a` in style.css
            // (#60a5fa / hover #93bbfd, underline offset 2).
            'underline underline-offset-2',
            'outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm',
            meta.status === 'loading' && 'text-[#60a5fa]/60 animate-pulse',
            meta.status === 'ok' && 'text-[#60a5fa] hover:text-[#93bbfd] cursor-pointer',
            meta.status === 'trashed' && 'text-muted-foreground line-through',
            meta.status === 'missing' && 'text-muted-foreground/70',
          )}
        >
          {label}
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={handleCopy}>
          <Copy className="size-3.5" />
          复制 ID
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function renderLabel(meta: NoteMeta, id: string): string {
  const shortId = `${id.slice(0, 8)}…`;
  switch (meta.status) {
    case 'loading':
      return shortId;
    case 'missing':
      return `{${shortId}}`;
    case 'ok':
    case 'trashed':
      return meta.title.length > LABEL_MAX ? `${meta.title.slice(0, LABEL_MAX)}…` : meta.title;
  }
}

function tooltipFor(meta: NoteMeta): string | undefined {
  switch (meta.status) {
    case 'trashed':
      return '已在回收站';
    case 'missing':
      return '笔记不存在';
    default:
      return undefined;
  }
}
