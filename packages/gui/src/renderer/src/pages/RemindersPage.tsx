import { extractTitle } from '@/components/NoteListItem';
import { formatTagLabel, tagIcon } from '@/components/TagChip';
import { TimeTagEditPopover } from '@/components/TimeTagEditPopover';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import * as api from '@/lib/api';
import type { Note, NoteTag } from '@/lib/api';
import {
  type NearestAlarm,
  type TimeRange,
  filterAndSortReminders,
  getFrequencyLabel,
} from '@/lib/reminder-utils';
import { openNoteById } from '@/stores/editor-store';
import { useReminderStore } from '@/stores/reminder-store';
import { Bell } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
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

/** Render a single tag chip — time tags as editable popovers, others as plain badges */
function TagDisplay({
  tag,
  onEditTag,
}: {
  tag: NoteTag;
  onEditTag: (tag: NoteTag, newValue: string) => void;
}) {
  const isTime = tag.tagType === '/time' || tag.tagType === '/alarm';
  if (isTime) {
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

function ReminderRow({
  note,
  nearest,
  onOpen,
  onEditTag,
}: {
  note: Note;
  nearest: NearestAlarm;
  onOpen: () => void;
  onEditTag: (tag: NoteTag, newValue: string) => void;
}) {
  const title = extractTitle(note.content);

  return (
    <div className="flex items-start px-3 py-2.5 border-b border-border hover:bg-accent/50 transition-colors">
      {/* Left: clickable note info + all tags */}
      <div className="flex-1 min-w-0">
        <button type="button" className="w-full text-left" onClick={onOpen}>
          <div className="text-sm font-medium truncate">{title}</div>
        </button>
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
          {note.tags.map((tag) => (
            <TagDisplay key={tag.id} tag={tag} onEditTag={onEditTag} />
          ))}
        </div>
      </div>

      {/* Right: nearest alarm time (prominent) */}
      <div className="shrink-0 flex flex-col items-end pl-3 pt-0.5">
        <div className="flex items-center gap-1.5 text-sm font-medium text-orange-400">
          <Bell className="size-4" />
          <span>{formatAlarmTime(nearest.time)}</span>
        </div>
        {nearest.frequency && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 mt-1">
            {getFrequencyLabel(nearest.frequency)}
          </Badge>
        )}
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

  const handleEditTag = useCallback(
    async (note: Note, tag: NoteTag, newValue: string) => {
      await api.editTagOnNote(note, tag.id, newValue);
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
              onEditTag={(tag, newValue) => handleEditTag(note, tag, newValue)}
            />
          ))
        )}
      </ScrollArea>
    </div>
  );
}
