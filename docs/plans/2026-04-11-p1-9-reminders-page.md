# P1-9 提醒页面 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a reminders page that shows future `/alarm` reminders with frequency-aware next-occurrence calculation, time range filtering, and edit/delete actions.

**Architecture:** New daemon endpoint `GET /reminders/alarms` returns all notes with `/alarm` tags in standard `Note[]` format. Frontend computes next occurrence per alarm (considering `/daily`/`/weekly`/`/monthly`/`/yearly` modifiers), filters by selected time range, sorts by nearest alarm. Zustand store preserves filter state across page switches.

**Tech Stack:** Fastify (daemon endpoint), zustand (state), shadcn/ui (Button, Badge, Popover, Calendar, ScrollArea), lucide-react icons

---

### Task 1: Core — listAlarmNotes function

**Files:**
- Modify: `packages/core/src/notes/index.ts` (add `listAlarmNotes` after `listNotes` ~line 212)
- Modify: `packages/core/src/index.ts` (add export)
- Test: `packages/core/src/notes/index.test.ts`

**Step 1: Write the failing test**

Add to `packages/core/src/notes/index.test.ts`:

```typescript
describe('listAlarmNotes', () => {
  it('returns notes with /alarm tags including all tags', () => {
    // Create two notes: one with /alarm, one without
    const noteWithAlarm = createNote(db, sqlite, {
      content: '# Alarm note',
      tags: [
        { tagType: '#', tagValue: '工作' },
        { tagType: '/alarm', tagValue: '2026-05-01T10:00:00' },
      ],
    });
    const noteWithoutAlarm = createNote(db, sqlite, {
      content: '# Normal note',
      tags: [{ tagType: '#', tagValue: '学习' }],
    });

    const result = listAlarmNotes(db, sqlite);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(noteWithAlarm.id);
    // Should include ALL tags, not just /alarm
    expect(result[0].tags).toHaveLength(2);
  });

  it('excludes trashed notes', () => {
    createNote(db, sqlite, {
      content: '# Trashed alarm',
      tags: [{ tagType: '/alarm', tagValue: '2026-05-01T10:00:00' }],
    });
    // Move to trash
    deleteNote(db, sqlite, db.select().from(schema.notes).all()[0].id);

    const result = listAlarmNotes(db, sqlite);
    expect(result).toHaveLength(0);
  });

  it('returns notes with multiple /alarm tags', () => {
    createNote(db, sqlite, {
      content: '# Multi alarm',
      tags: [
        { tagType: '/alarm', tagValue: '2026-05-01T10:00:00' },
        { tagType: '/alarm', tagValue: '2026-06-01T10:00:00' },
        { tagType: '/weekly', tagValue: '' },
      ],
    });

    const result = listAlarmNotes(db, sqlite);
    expect(result).toHaveLength(1);
    expect(result[0].tags).toHaveLength(3);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test -- --grep "listAlarmNotes"`
Expected: FAIL — `listAlarmNotes` is not defined

**Step 3: Write implementation**

In `packages/core/src/notes/index.ts`, add after `listNotes` function (~line 212):

```typescript
/** Return all non-trashed notes that have at least one /alarm tag, with full tags attached. */
export function listAlarmNotes(
  db: OwlDatabase,
  sqlite: Database.Database,
): NoteWithTags[] {
  // Find note IDs that have /alarm tags and are not trashed
  const alarmNoteIds = db
    .select({ noteId: noteTags.noteId })
    .from(noteTags)
    .innerJoin(tags, eq(noteTags.tagId, tags.id))
    .innerJoin(notes, eq(noteTags.noteId, notes.id))
    .where(and(eq(tags.tagType, '/alarm'), eq(notes.trashLevel, 0)))
    .all()
    .map((r) => r.noteId);

  if (alarmNoteIds.length === 0) return [];

  // Deduplicate (a note with 2 /alarm tags appears twice)
  const uniqueIds = [...new Set(alarmNoteIds)];

  const rows = db
    .select()
    .from(notes)
    .where(inArray(notes.id, uniqueIds))
    .all();

  return rows.map((note) => {
    const noteTags_ = db
      .select({ id: tags.id, tagType: tags.tagType, tagValue: tags.tagValue })
      .from(noteTags)
      .innerJoin(tags, eq(noteTags.tagId, tags.id))
      .where(eq(noteTags.noteId, note.id))
      .all();
    return { ...note, tags: noteTags_ };
  });
}
```

In `packages/core/src/index.ts`, add `listAlarmNotes` to the Notes export block.

**Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test`
Expected: All pass

**Step 5: Commit**

```
feat(notes): add listAlarmNotes for reminder page
```

---

### Task 2: Daemon — GET /reminders/alarms endpoint

**Files:**
- Modify: `packages/daemon/src/routes/tags.ts` (add route after existing `/reminders/upcoming`)
- Modify: `packages/daemon/src/routes/system.ts` (add to capabilities)
- Test: `packages/daemon/src/server.test.ts`

**Step 1: Write the failing test**

Add to `packages/daemon/src/server.test.ts`:

```typescript
describe('GET /reminders/alarms', () => {
  it('returns notes with /alarm tags in standard Note format', async () => {
    // Create a note with /alarm tag
    await app.inject({
      method: 'POST',
      url: '/notes',
      payload: {
        content: '# Alarm test',
        tags: ['/alarm 2026-05-01 10:00'],
      },
    });
    // Create a note without /alarm
    await app.inject({
      method: 'POST',
      url: '/notes',
      payload: { content: '# No alarm', tags: ['#工作'] },
    });

    const res = await app.inject({ method: 'GET', url: '/reminders/alarms' });
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].tags).toBeDefined();
    expect(Array.isArray(body.data[0].tags)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/daemon && pnpm test -- --grep "reminders/alarms"`
Expected: FAIL — 404

**Step 3: Write implementation**

In `packages/daemon/src/routes/tags.ts`, add the import `listAlarmNotes` from `@owl/core` and add route:

```typescript
// GET /reminders/alarms — all notes with /alarm tags (standard Note[] format)
app.get('/reminders/alarms', async (_req, reply) => {
  const items = listAlarmNotes(ctx.db, ctx.sqlite);
  ok(reply, items);
});
```

In `packages/daemon/src/routes/system.ts`, add to capabilities:

```typescript
{ method: 'GET', path: '/reminders/alarms', description: 'Get all notes with alarm tags' },
```

**Step 4: Run tests**

Run: `cd packages/daemon && pnpm test`
Expected: All pass

**Step 5: Commit**

```
feat(daemon): add GET /reminders/alarms endpoint
```

---

### Task 3: GUI — API client + reminder utilities + reminder store

**Files:**
- Modify: `packages/gui/src/renderer/src/lib/api.ts` (add `listAlarmNotes`)
- Create: `packages/gui/src/renderer/src/lib/reminder-utils.ts`
- Create: `packages/gui/src/renderer/src/stores/reminder-store.ts`

**Step 1: Add API client function**

In `packages/gui/src/renderer/src/lib/api.ts`, add at the end of the Reminders section:

```typescript
export const listAlarmNotes = () => request<Note[]>('GET', '/reminders/alarms');
```

**Step 2: Create reminder-utils.ts**

Create `packages/gui/src/renderer/src/lib/reminder-utils.ts`:

```typescript
import type { Note, NoteTag } from './api';

export type TimeRange = 'today' | 'week' | 'month' | '7d' | '30d' | 'all';

export type Frequency = '/daily' | '/weekly' | '/monthly' | '/yearly';

const FREQUENCIES: readonly string[] = ['/daily', '/weekly', '/monthly', '/yearly'];

const FREQUENCY_LABELS: Record<Frequency, string> = {
  '/daily': '每日',
  '/weekly': '每周',
  '/monthly': '每月',
  '/yearly': '每年',
};

export function getFrequencyLabel(freq: Frequency): string {
  return FREQUENCY_LABELS[freq];
}

/** Compute the next occurrence of an alarm, advancing by frequency if needed. */
export function getNextOccurrence(
  alarmTime: Date,
  frequency: Frequency | null,
  now: Date,
): Date | null {
  if (!frequency) {
    return alarmTime > now ? alarmTime : null;
  }
  const next = new Date(alarmTime);
  while (next <= now) {
    switch (frequency) {
      case '/daily':
        next.setDate(next.getDate() + 1);
        break;
      case '/weekly':
        next.setDate(next.getDate() + 7);
        break;
      case '/monthly':
        next.setMonth(next.getMonth() + 1);
        break;
      case '/yearly':
        next.setFullYear(next.getFullYear() + 1);
        break;
    }
  }
  return next;
}

export interface NearestAlarm {
  time: Date;
  tag: NoteTag;
  frequency: Frequency | null;
}

/** Get the nearest future alarm for a note, considering frequency modifiers. */
export function getNearestAlarm(note: Note, now: Date): NearestAlarm | null {
  const freqTag = note.tags.find((t) => FREQUENCIES.includes(t.tagType));
  const frequency = (freqTag?.tagType as Frequency) ?? null;

  let nearest: NearestAlarm | null = null;
  for (const tag of note.tags) {
    if (tag.tagType !== '/alarm' || !tag.tagValue) continue;
    const next = getNextOccurrence(new Date(tag.tagValue), frequency, now);
    if (next && (!nearest || next < nearest.time)) {
      nearest = { time: next, tag, frequency };
    }
  }
  return nearest;
}

/** Compute the time range bounds for filtering. */
export function getTimeRangeBounds(range: TimeRange, now: Date): [Date, Date] | null {
  if (range === 'all') return null;

  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getTime() + 86400000 - 1);

  switch (range) {
    case 'today':
      return [startOfDay, endOfDay];
    case 'week': {
      const dayOfWeek = now.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(startOfDay);
      monday.setDate(monday.getDate() + mondayOffset);
      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 6);
      sunday.setHours(23, 59, 59, 999);
      return [monday, sunday];
    }
    case 'month': {
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      return [firstDay, lastDay];
    }
    case '7d':
      return [now, new Date(now.getTime() + 7 * 86400000)];
    case '30d':
      return [now, new Date(now.getTime() + 30 * 86400000)];
  }
}

/** Filter and sort notes by their nearest future alarm within a time range. */
export function filterAndSortReminders(
  notes: Note[],
  timeRange: TimeRange,
  now: Date,
): { note: Note; nearest: NearestAlarm }[] {
  const bounds = getTimeRangeBounds(timeRange, now);
  const results: { note: Note; nearest: NearestAlarm }[] = [];

  for (const note of notes) {
    const nearest = getNearestAlarm(note, now);
    if (!nearest) continue;
    if (bounds) {
      const [start, end] = bounds;
      if (nearest.time < start || nearest.time > end) continue;
    }
    results.push({ note, nearest });
  }

  results.sort((a, b) => a.nearest.time.getTime() - b.nearest.time.getTime());
  return results;
}
```

**Step 3: Create reminder-store.ts**

Create `packages/gui/src/renderer/src/stores/reminder-store.ts`:

```typescript
import type { Note } from '@/lib/api';
import * as api from '@/lib/api';
import type { TimeRange } from '@/lib/reminder-utils';
import { create } from 'zustand';

interface ReminderState {
  timeRange: TimeRange;
  notes: Note[];
  loading: boolean;

  setTimeRange: (range: TimeRange) => void;
  fetchReminders: () => Promise<void>;
}

export const useReminderStore = create<ReminderState>((set, get) => ({
  timeRange: 'all',
  notes: [],
  loading: false,

  setTimeRange: (range: TimeRange) => {
    set({ timeRange: range });
  },

  fetchReminders: async () => {
    set({ loading: true });
    try {
      const res = await api.listAlarmNotes();
      set({ notes: res.data ?? [] });
    } finally {
      set({ loading: false });
    }
  },
}));
```

**Step 4: Run typecheck**

Run: `just check`
Expected: Zero errors

**Step 5: Commit**

```
feat(gui): add reminder utils, store, and API client
```

---

### Task 4: GUI — RemindersPage component

**Files:**
- Rewrite: `packages/gui/src/renderer/src/pages/RemindersPage.tsx`

**Step 1: Implement the page**

Rewrite `packages/gui/src/renderer/src/pages/RemindersPage.tsx`:

```tsx
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
import { useReminderStore } from '@/stores/reminder-store';
import { openNoteById } from '@/stores/editor-store';
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
      // Remove only this /alarm tag, keep all others
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
      // Replace this alarm's value, keep all other tags
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
```

**Step 2: Run typecheck**

Run: `just check`
Expected: Zero errors

**Step 3: Commit**

```
feat(gui): implement RemindersPage with alarm filtering and editing
```

---

### Task 5: Manual testing + polish

**Step 1: Start daemon and create test data**

Run: `just dev-daemon`

Create test notes via daemon API:

```bash
# Note with future /alarm (no frequency)
curl -X POST http://127.0.0.1:47010/notes -H 'Content-Type: application/json' \
  -d '{"content":"# 未来单次提醒\n\n这是一个测试","tags":["#测试","/alarm 2026-04-15 10:00"]}'

# Note with past /alarm + /weekly (should compute next weekly occurrence)
curl -X POST http://127.0.0.1:47010/notes -H 'Content-Type: application/json' \
  -d '{"content":"# 每周会议提醒\n\n周例会","tags":["#工作","/alarm 2026-04-07 19:00","/weekly"]}'

# Note with multiple /alarm tags
curl -X POST http://127.0.0.1:47010/notes -H 'Content-Type: application/json' \
  -d '{"content":"# 多提醒笔记\n\n两个提醒","tags":["#重要","/alarm 2026-04-20 09:00","/alarm 2026-05-01 14:00"]}'

# Note with past /alarm, no frequency (should NOT show)
curl -X POST http://127.0.0.1:47010/notes -H 'Content-Type: application/json' \
  -d '{"content":"# 过期提醒\n\n已过期","tags":["#旧","/alarm 2026-01-01 08:00"]}'

# Note without /alarm (should NOT show)
curl -X POST http://127.0.0.1:47010/notes -H 'Content-Type: application/json' \
  -d '{"content":"# 普通笔记\n\n无提醒","tags":["#学习"]}'
```

**Step 2: Output manual test checklist for user**

```
### 手动测试：提醒页面 (P1-9)

测试步骤：
1. Cmd+4 切换到提醒页 → 预期：显示提醒列表，"全部" 按钮高亮
2. 检查列表内容 → 预期：显示 3 条（未来单次、每周会议、多提醒笔记），不显示过期和无提醒笔记
3. 检查每周会议提醒 → 预期：显示的时间是计算后的下一个周一 19:00，显示"每周"标签
4. 检查多提醒笔记 → 预期：显示较近的 04-20 09:00
5. 点击"今天"按钮 → 预期：列表过滤为今天范围内的提醒（可能为空）
6. 点击"7天"按钮 → 预期：只显示 7 天内的提醒
7. 点击"全部"按钮 → 预期：恢复显示所有提醒
8. 切换到编辑页(Cmd+1)再切回提醒页(Cmd+4) → 预期：之前选中的时间范围保持
9. 点击某条提醒的笔记标题 → 预期：跳转到编辑页，该笔记在新 Tab 中打开
10. 回到提醒页，点击修改按钮 → 预期：弹出日期时间选择器，修改后列表更新重排序
11. 点击删除按钮 → 预期：该提醒从列表消失
```

**Step 3: Fix any issues found during manual testing**

**Step 4: Final check**

Run: `just check`
Expected: Zero errors

**Step 5: Commit (if any polish fixes)**

```
fix(gui): polish RemindersPage after manual testing
```
