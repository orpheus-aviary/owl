import { Badge } from '@/components/ui/badge';
import type { Note } from '@/lib/api';
import { cn } from '@/lib/utils';

const MAX_VISIBLE_TAGS = 5;

/** Extract display title from note content. First `# ` heading, or first non-empty line. */
export function extractTitle(content: string): string {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === '#' || trimmed.startsWith('# ')) return trimmed.slice(1).trim() || '无标题';
    return trimmed;
  }
  return '无标题';
}

/** Extract preview text: first non-empty line after the title line. */
export function extractPreview(content: string): string {
  let pastTitle = false;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!pastTitle) {
      pastTitle = true;
      continue;
    }
    // Skip markdown headings in preview
    if (trimmed.startsWith('#')) continue;
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  }
  return '';
}

/** Format date to MM-DD HH:mm */
function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

interface NoteListItemProps {
  note: Note;
  isActive: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  /** Which sort field is active, used to highlight the relevant timestamp */
  activeSort?: 'updated' | 'created';
}

export function NoteListItem({
  note,
  isActive,
  onClick,
  onDoubleClick,
  activeSort,
}: NoteListItemProps) {
  const title = extractTitle(note.content);
  const preview = extractPreview(note.content);
  const hashtags = note.tags.filter((t) => t.tagType === '#');
  const visible = hashtags.slice(0, MAX_VISIBLE_TAGS);
  const overflow = hashtags.length - MAX_VISIBLE_TAGS;

  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        'w-full text-left px-3 py-2 border-b border-border transition-colors outline-none',
        'hover:bg-accent/50',
        isActive && 'bg-accent border-l-2 border-l-primary',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">{title}</div>
          <div className="text-xs text-muted-foreground truncate mt-0.5 min-h-[16px]">
            {preview || '\u00A0'}
          </div>
          <div className="flex gap-1 mt-1 min-h-[18px] flex-wrap">
            {visible.map((tag) => (
              <Badge key={tag.id} variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                #{tag.tagValue}
              </Badge>
            ))}
            {overflow > 0 && (
              <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
                +{overflow}
              </Badge>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right text-xs leading-relaxed pt-0.5">
          <div
            className={cn(
              activeSort === 'created' ? 'text-foreground font-bold' : 'text-muted-foreground',
            )}
          >
            创建 {formatTime(note.createdAt)}
          </div>
          <div
            className={cn(
              activeSort === 'updated' || !activeSort
                ? 'text-foreground font-bold'
                : 'text-muted-foreground',
            )}
          >
            修改 {formatTime(note.updatedAt)}
          </div>
        </div>
      </div>
    </button>
  );
}
