import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { NoteTag } from '@/lib/api';
import { useState } from 'react';
import { formatTagLabel, tagIcon } from './TagChip';
import { Badge } from './ui/badge';

interface TimeTagEditPopoverProps {
  tag: NoteTag;
  onConfirm: (tag: NoteTag, newValue: string) => void;
}

export function TimeTagEditPopover({ tag, onConfirm }: TimeTagEditPopoverProps) {
  const [open, setOpen] = useState(false);
  const initial = tag.tagValue ? new Date(tag.tagValue) : new Date();
  const [date, setDate] = useState<Date>(initial);
  const [time, setTime] = useState(
    `${String(initial.getHours()).padStart(2, '0')}:${String(initial.getMinutes()).padStart(2, '0')}`,
  );

  const handleOpen = (isOpen: boolean) => {
    setOpen(isOpen);
    if (isOpen) {
      // Reset to current tag value when opening
      const d = tag.tagValue ? new Date(tag.tagValue) : new Date();
      setDate(d);
      setTime(
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
      );
    }
  };

  const handleConfirm = () => {
    const [hh, mm] = time.split(':').map(Number);
    const result = new Date(date);
    result.setHours(hh, mm, 0, 0);
    const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
    const iso = `${pad(result.getFullYear(), 4)}-${pad(result.getMonth() + 1)}-${pad(result.getDate())}T${pad(result.getHours())}:${pad(result.getMinutes())}:00`;
    onConfirm(tag, iso);
    setOpen(false);
  };

  const icon = tagIcon(tag.tagType);
  const label = formatTagLabel(tag);

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="cursor-pointer">
          <Badge
            variant="secondary"
            className="gap-1 text-[10px] px-1.5 py-0 shrink-0 hover:bg-accent"
          >
            {icon}
            {label}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" side="top">
        <Calendar mode="single" selected={date} onSelect={(d) => d && setDate(d)} />
        <div className="flex items-center gap-2 px-3 pb-3">
          <Input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="h-8 w-28 text-xs"
          />
          <Button size="sm" className="h-8" onClick={handleConfirm}>
            确认
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
