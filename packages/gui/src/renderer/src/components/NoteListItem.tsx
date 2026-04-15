import { Badge } from '@/components/ui/badge';
import type { Note, NoteTag } from '@/lib/api';
import { formatDateCompact } from '@/lib/date-format';
import type { DragData } from '@/lib/dnd-types';
import { sortTags } from '@/lib/tag-sort';
import { cn } from '@/lib/utils';
import { useDraggable } from '@dnd-kit/core';
import { useMemo } from 'react';
import { TagDisplay } from './TagDisplay';

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
    if (trimmed.startsWith('#')) continue;
    return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
  }
  return '';
}

interface NoteListItemProps {
  note: Note;
  isActive: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
  activeSort?: 'updated' | 'created';
  onEditTag?: (tag: NoteTag, newValue: string) => void;
  draggable?: boolean;
}

export function NoteListItem({
  note,
  isActive,
  onClick,
  onDoubleClick,
  activeSort,
  onEditTag,
  draggable = false,
}: NoteListItemProps) {
  const title = extractTitle(note.content);
  const preview = extractPreview(note.content);
  const sorted = useMemo(() => sortTags(note.tags), [note.tags]);
  const visible = sorted.slice(0, MAX_VISIBLE_TAGS);
  const overflow = sorted.length - MAX_VISIBLE_TAGS;

  const dragData: DragData = { kind: 'note', noteId: note.id };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `note:${note.id}`,
    data: dragData,
    disabled: !draggable,
  });

  return (
    <button
      ref={setNodeRef}
      {...(draggable ? listeners : {})}
      {...(draggable ? attributes : {})}
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        'w-full text-left px-3 py-2 border-b border-border transition-colors outline-none',
        'hover:bg-accent/50',
        isActive && 'bg-accent border-l-2 border-l-primary',
        isDragging && 'opacity-40',
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
              <TagDisplay key={tag.id} tag={tag} onEditTag={onEditTag} />
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
            创建 {formatDateCompact(new Date(note.createdAt))}
          </div>
          <div
            className={cn(
              activeSort === 'updated' || !activeSort
                ? 'text-foreground font-bold'
                : 'text-muted-foreground',
            )}
          >
            修改 {formatDateCompact(new Date(note.updatedAt))}
          </div>
        </div>
      </div>
    </button>
  );
}
