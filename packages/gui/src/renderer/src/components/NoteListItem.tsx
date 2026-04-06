import { Badge } from '@/components/ui/badge';
import type { Note } from '@/lib/api';
import { cn } from '@/lib/utils';

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

interface NoteListItemProps {
  note: Note;
  isActive: boolean;
  onClick: () => void;
}

export function NoteListItem({ note, isActive, onClick }: NoteListItemProps) {
  const title = extractTitle(note.content);
  const preview = extractPreview(note.content);
  const hashtags = note.tags.filter((t) => t.tagType === '#');

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left px-3 py-2 border-b border-border transition-colors',
        'hover:bg-accent/50',
        isActive && 'bg-accent',
      )}
    >
      <div className="text-sm font-medium truncate">{title}</div>
      {preview && <div className="text-xs text-muted-foreground truncate mt-0.5">{preview}</div>}
      {hashtags.length > 0 && (
        <div className="flex gap-1 mt-1 flex-wrap">
          {hashtags.map((tag) => (
            <Badge key={tag.id} variant="secondary" className="text-[10px] px-1.5 py-0">
              #{tag.tagValue}
            </Badge>
          ))}
        </div>
      )}
    </button>
  );
}
