import { Badge } from '@/components/ui/badge';
import type { Note, NoteTag } from '@/lib/api';
import { formatDateCompact } from '@/lib/date-format';
import type { DragData } from '@/lib/dnd-types';
import { specialNoteColorVar } from '@/lib/special-notes';
import { sortTags } from '@/lib/tag-sort';
import { cn } from '@/lib/utils';
import { useDraggable } from '@dnd-kit/core';
import { Pin } from 'lucide-react';
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
  /**
   * When `true` (default), renders a subtle background for pinned notes.
   * FolderPanel passes `false` — there pin is a property indicator only and
   * must not affect sorting or background, per P3.4-a design §1.1.
   */
  showPinBackground?: boolean;
}

export function NoteListItem({
  note,
  isActive,
  onClick,
  onDoubleClick,
  activeSort,
  onEditTag,
  draggable = false,
  showPinBackground = true,
}: NoteListItemProps) {
  const title = extractTitle(note.content);
  const preview = extractPreview(note.content);
  const sorted = useMemo(() => sortTags(note.tags), [note.tags]);
  const visible = sorted.slice(0, MAX_VISIBLE_TAGS);
  const overflow = sorted.length - MAX_VISIBLE_TAGS;
  const pinned = note.pinnedAt != null;
  const specialColor = specialNoteColorVar(note.id);

  const dragData: DragData = { kind: 'note', noteId: note.id };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `note:${note.id}`,
    data: dragData,
    disabled: !draggable,
  });

  // Use a div instead of button: TagDisplay inside renders Popover / Dialog
  // triggers which are themselves <button>s, and a button inside a button
  // breaks React's hydration. role + tabIndex + key handler keep this
  // accessible for keyboard users.
  return (
    <div
      ref={setNodeRef}
      {...(draggable ? listeners : {})}
      {...(draggable ? attributes : {})}
      // biome-ignore lint/a11y/useSemanticElements: nested <button> breaks hydration — TagDisplay renders Popover/Dialog triggers.
      role="button"
      tabIndex={0}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      // inset box-shadow (not border-l) — coexists with the 2px active border
      // and the pinned background instead of fighting them. See P3.4-b design §3.
      style={specialColor ? { boxShadow: `inset 4px 0 0 ${specialColor}` } : undefined}
      className={cn(
        'w-full text-left px-3 py-2 border-b border-border transition-colors outline-none cursor-pointer select-none',
        'hover:bg-accent/50',
        pinned && showPinBackground && 'bg-primary/5',
        isActive && 'bg-accent border-l-2 border-l-primary',
        isDragging && 'opacity-40',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {pinned && (
              <Pin className="size-3 shrink-0 text-primary rotate-45" aria-label="已置顶" />
            )}
            <div className="text-sm font-medium truncate">{title}</div>
          </div>
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
    </div>
  );
}
