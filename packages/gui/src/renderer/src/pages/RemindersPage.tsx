import { extractTitle } from '@/components/NoteListItem';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import * as api from '@/lib/api';
import type { Note, NoteTag } from '@/lib/api';
import {
  type Frequency,
  type NearestAlarm,
  type TimeRange,
  filterAndSortReminders,
  getFrequencyLabel,
} from '@/lib/reminder-utils';
import { openNoteById } from '@/stores/editor-store';
import { useReminderStore } from '@/stores/reminder-store';
import { Clock, Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const TIME_RANGES: { key: TimeRange; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: '7d', label: '7天' },
  { key: '30d', label: '30天' },
  { key: 'all', label: '全部' },
];

function formatAlarmTime(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

function AlarmEditPopover({
  tag,
  onConfirm,
}: {
  tag: NoteTag;
  onConfirm: (newValue: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const initial = tag.tagValue ? new Date(tag.tagValue) : new Date();
  const [date, setDate] = useState<Date>(initial);
  const [time, setTime] = useState(
    `${String(initial.getHours()).padStart(2, '0')}:${String(initial.getMinutes()).padStart(2, '0')}`,
  );

  const handleConfirm = () => {
    const [hh, mm] = time.split(':').map(Number);
    const result = new Date(date);
    result.setHours(hh, mm, 0, 0);
    const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
    const iso = `${pad(result.getFullYear(), 4)}-${pad(result.getMonth() + 1)}-${pad(result.getDate())}T${pad(result.getHours())}:${pad(result.getMinutes())}:00`;
    onConfirm(iso);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" title="修改时间">
          <Pencil className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="end" side="top">
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

function ReminderRow({
  note,
  nearest,
  onOpen,
  onDelete,
  onEditAlarm,
}: {
  note: Note;
  nearest: NearestAlarm;
  onOpen: () => void;
  onDelete: () => void;
  onEditAlarm: (tag: NoteTag, newValue: string) => void;
}) {
  const title = extractTitle(note.content);
  const hashtags = note.tags.filter((t) => t.tagType === '#');

  return (
    <div className="flex items-start px-3 py-2.5 border-b border-border hover:bg-accent/50 transition-colors">
      <button type="button" className="flex-1 min-w-0 text-left" onClick={onOpen}>
        <div className="text-sm font-medium truncate">{title}</div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {hashtags.slice(0, 5).map((tag) => (
            <Badge key={tag.id} variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
              #{tag.tagValue}
            </Badge>
          ))}
        </div>
      </button>
      <div className="shrink-0 flex flex-col items-end gap-1 pl-2">
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="size-3" />
          <span>{formatAlarmTime(nearest.time)}</span>
          {nearest.frequency && (
            <Badge variant="outline" className="text-[10px] px-1 py-0">
              {getFrequencyLabel(nearest.frequency)}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <AlarmEditPopover
            tag={nearest.tag}
            onConfirm={(newValue) => onEditAlarm(nearest.tag, newValue)}
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-destructive hover:text-destructive"
            title="删除提醒"
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function RemindersPage() {
  const { timeRange, notes, loading, setTimeRange, fetchReminders } = useReminderStore();
  const navigate = useNavigate();

  useEffect(() => {
    fetchReminders();
  }, [fetchReminders]);

  const filtered = useMemo(
    () => filterAndSortReminders(notes, timeRange, new Date()),
    [notes, timeRange],
  );

  const handleOpen = useCallback(
    (noteId: string) => {
      openNoteById(noteId);
      navigate('/');
    },
    [navigate],
  );

  const handleDeleteAlarm = useCallback(
    async (note: Note, alarmTag: NoteTag) => {
      const remainingTags = note.tags
        .filter((t) => t.id !== alarmTag.id)
        .map((t) => {
          if (t.tagType === '#') return `#${t.tagValue}`;
          if (t.tagValue) return `${t.tagType} ${t.tagValue}`;
          return t.tagType;
        });
      await api.updateNote(note.id, { content: note.content, tags: remainingTags });
      fetchReminders();
    },
    [fetchReminders],
  );

  const handleEditAlarm = useCallback(
    async (note: Note, alarmTag: NoteTag, newValue: string) => {
      const updatedTags = note.tags.map((t) => {
        if (t.id === alarmTag.id) return { ...t, tagValue: newValue };
        return t;
      });
      const tagStrings = updatedTags.map((t) => {
        if (t.tagType === '#') return `#${t.tagValue}`;
        if (t.tagValue) return `${t.tagType} ${t.tagValue}`;
        return t.tagType;
      });
      await api.updateNote(note.id, { content: note.content, tags: tagStrings });
      fetchReminders();
    },
    [fetchReminders],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header: time range buttons */}
      <div className="shrink-0 p-3 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {TIME_RANGES.map(({ key, label }) => (
              <Button
                key={key}
                variant={timeRange === key ? 'default' : 'ghost'}
                size="sm"
                className="h-8"
                onClick={() => setTimeRange(key)}
              >
                {label}
              </Button>
            ))}
          </div>
          <span className="ml-auto text-xs text-muted-foreground">共 {filtered.length} 条提醒</span>
        </div>
      </div>

      {/* Reminder list */}
      <ScrollArea className="flex-1 min-h-0">
        {loading && notes.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">加载中...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {timeRange === 'all' ? '暂无提醒' : '该时间范围内无提醒'}
          </div>
        ) : (
          filtered.map(({ note, nearest }) => (
            <ReminderRow
              key={`${note.id}-${nearest.tag.id}`}
              note={note}
              nearest={nearest}
              onOpen={() => handleOpen(note.id)}
              onDelete={() => handleDeleteAlarm(note, nearest.tag)}
              onEditAlarm={(tag, newValue) => handleEditAlarm(note, tag, newValue)}
            />
          ))
        )}
      </ScrollArea>
    </div>
  );
}
