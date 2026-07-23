import { extractTitle } from '@/components/NoteListItem';
import { TagDisplay } from '@/components/TagDisplay';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useOpenNote } from '@/hooks/useOpenNote';
import * as api from '@/lib/api';
import type { Note, NoteTag } from '@/lib/api';
import { formatDateCompact } from '@/lib/date-format';
import { type NearestAlarm, type TimeRange, filterAndSortReminders } from '@/lib/reminder-utils';
import { sortTags } from '@/lib/tag-sort';
import { cn } from '@/lib/utils';
import { useReminderStore } from '@/stores/reminder-store';
import { currentGen, isStale } from '@/stores/session-epoch';
import { Bell } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';

const TIME_RANGES: { key: TimeRange; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: '7d', label: '7天' },
  { key: '30d', label: '30天' },
  { key: 'all', label: '全部' },
];

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
  const sorted = useMemo(() => sortTags(note.tags), [note.tags]);

  return (
    <div className="flex items-center px-3 py-2.5 border-b border-border hover:bg-accent/50 transition-colors">
      <div className="flex-1 min-w-0">
        <button type="button" className="w-full text-left" onClick={onOpen}>
          <div className="text-sm font-medium truncate">{title}</div>
        </button>
        <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
          {sorted.map((tag) => (
            <TagDisplay key={tag.id} tag={tag} onEditTag={onEditTag} />
          ))}
        </div>
      </div>

      <div className="shrink-0 flex items-center gap-1.5 pl-3 text-sm font-medium text-orange-400">
        <Bell className="size-4" />
        <span>{formatDateCompact(nearest.time)}</span>
      </div>
    </div>
  );
}

export function RemindersPage() {
  const { timeRange, notes, loading, setTimeRange, fetchReminders } = useReminderStore();
  const openNote = useOpenNote();
  const isMobile = useIsMobile();

  useEffect(() => {
    fetchReminders();
  }, [fetchReminders]);

  const filtered = useMemo(
    () => filterAndSortReminders(notes, timeRange, new Date()),
    [notes, timeRange],
  );

  const handleOpen = useCallback(
    (noteId: string) => {
      // useOpenNote: desktop = openNoteById + navigate('/') (unchanged); mobile
      // routes to /note/:id through the note-nav guard.
      void openNote({ noteId });
    },
    [openNote],
  );

  const handleEditTag = useCallback(
    async (note: Note, tag: NoteTag, newValue: string) => {
      const gen = currentGen();
      await api.editTagOnNote(note, tag.id, newValue);
      if (isStale(gen)) return;
      fetchReminders();
    },
    [fetchReminders],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 p-3 border-b border-border">
        {/* Mobile stacks the count onto its own line below the ranges so the
            filter row isn't overrun; desktop keeps the single inline row with
            `ml-auto` (byte-identical when !isMobile). */}
        <div
          className={cn('flex items-center gap-2', isMobile && 'flex-col items-stretch gap-1.5')}
        >
          <div className={cn('flex gap-1', isMobile && 'flex-wrap')}>
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
          <span className={cn('text-xs text-muted-foreground', isMobile ? 'self-end' : 'ml-auto')}>
            共 {filtered.length} 条提醒
          </span>
        </div>
      </div>

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
