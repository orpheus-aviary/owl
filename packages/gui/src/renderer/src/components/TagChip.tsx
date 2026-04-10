import { Badge } from '@/components/ui/badge';
import type { NoteTag } from '@/lib/api';
import { Bell, Clock, Repeat, X } from 'lucide-react';

export function formatTagLabel(tag: NoteTag): string {
  switch (tag.tagType) {
    case '#':
      return `#${tag.tagValue}`;
    case '/time':
    case '/alarm': {
      if (!tag.tagValue) return tag.tagType;
      const d = new Date(tag.tagValue);
      if (Number.isNaN(d.getTime())) return tag.tagValue;
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      const yearPrefix = yyyy !== new Date().getFullYear() ? `${yyyy}-` : '';
      return `${yearPrefix}${mm}-${dd} ${hh}:${min}`;
    }
    case '/daily':
      return '每日';
    case '/weekly':
      return '每周';
    case '/monthly':
      return '每月';
    case '/yearly':
      return '每年';
    default:
      return tag.tagValue ?? tag.tagType;
  }
}

// Icon color classes per tag type
const ICON_COLORS: Record<string, string> = {
  '/time': 'text-blue-400',
  '/alarm': 'text-orange-400',
  '/daily': 'text-green-400',
  '/weekly': 'text-green-400',
  '/monthly': 'text-green-400',
  '/yearly': 'text-green-400',
};

export function tagIcon(tagType: string) {
  const color = ICON_COLORS[tagType] ?? '';
  switch (tagType) {
    case '/time':
      return <Clock className={`size-3 ${color}`} />;
    case '/alarm':
      return <Bell className={`size-3 ${color}`} />;
    case '/daily':
    case '/weekly':
    case '/monthly':
    case '/yearly':
      return <Repeat className={`size-3 ${color}`} />;
    default:
      return null;
  }
}

interface TagChipProps {
  tag: NoteTag;
  onDelete: () => void;
  onClick?: () => void;
}

export function TagChip({ tag, onDelete, onClick }: TagChipProps) {
  const icon = tagIcon(tag.tagType);
  const label = formatTagLabel(tag);
  const isClickable = tag.tagType === '/time' || tag.tagType === '/alarm';

  return (
    <Badge variant="secondary" className="gap-1 px-1.5 py-0.5 text-xs">
      {icon}
      {isClickable ? (
        <button type="button" onClick={onClick} className="cursor-pointer hover:underline">
          {label}
        </button>
      ) : (
        <span>{label}</span>
      )}
      <button
        type="button"
        onClick={onDelete}
        className="ml-0.5 cursor-pointer rounded-sm hover:bg-muted-foreground/20"
      >
        <X className="size-3" />
      </button>
    </Badge>
  );
}
