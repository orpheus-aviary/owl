import { Badge } from '@/components/ui/badge';
import type { NoteTag } from '@/lib/api';
import { formatTagLabel, tagIcon } from './TagChip';
import { TimeTagEditPopover } from './TimeTagEditPopover';

interface TagDisplayProps {
  tag: NoteTag;
  onEditTag?: (tag: NoteTag, newValue: string) => void;
}

/** Renders a tag chip — /time and /alarm are clickable date pickers if onEditTag is provided. */
export function TagDisplay({ tag, onEditTag }: TagDisplayProps) {
  const isTime = tag.tagType === '/time' || tag.tagType === '/alarm';
  if (isTime && onEditTag) {
    return <TimeTagEditPopover tag={tag} onConfirm={onEditTag} />;
  }

  const icon = tagIcon(tag.tagType);
  const label = formatTagLabel(tag);
  return (
    <Badge variant="secondary" className="gap-1 text-[10px] px-1.5 py-0 shrink-0">
      {icon}
      {label}
    </Badge>
  );
}
