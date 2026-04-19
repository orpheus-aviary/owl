# P1-10: Reminder Scheduler Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persistent reminder tracking (reminder_status table), a daemon-side scheduler that fires system OS notifications at the right time, and auto-cleanup of expired trash.

**Architecture:** DB is the single source of truth for reminder state. The daemon scheduler uses event-driven setTimeout for precise triggering, with a 5-second heartbeat for sleep detection. System notifications via `node-notifier`. No GUI-internal notifications.

**Tech Stack:** better-sqlite3, drizzle-orm, node-notifier, bun:test

---

### Task 1: Add `reminder_status` table to schema + DDL

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Modify: `packages/core/src/db/index.ts`

**Step 1: Add drizzle schema definition**

In `packages/core/src/db/schema.ts`, add after `localMetadata`:

```typescript
// ─── Reminder Status (alarm scheduling persistence) ───

export const reminderStatus = sqliteTable(
  'reminder_status',
  {
    noteId: text('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id),
    fireAt: integer('fire_at', { mode: 'number' }).notNull(),
    status: text('status').notNull().default('pending'),
    firedAt: integer('fired_at', { mode: 'number' }),
  },
  (table) => [primaryKey({ columns: [table.noteId, table.tagId] })],
);
```

**Step 2: Add DDL in `packages/core/src/db/index.ts`**

Append to the DDL string, before the closing backtick:

```sql
CREATE TABLE IF NOT EXISTS reminder_status (
  note_id   TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES tags(id),
  fire_at   INTEGER NOT NULL,
  status    TEXT NOT NULL DEFAULT 'pending',
  fired_at  INTEGER,
  PRIMARY KEY (note_id, tag_id)
);
```

**Step 3: Run tests to verify nothing broke**

Run: `cd /Users/jayncp/Desktop/jayncp_mac/orpheus-aviary/owl && pnpm --filter @owl/core test`
Expected: All 53 existing tests PASS

**Step 4: Commit**

```
feat(db): add reminder_status table for persistent alarm tracking
```

---

### Task 2: Create reminder sync logic in core

**Files:**
- Create: `packages/core/src/reminders/index.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/reminders/index.test.ts`

**Step 1: Write failing tests**

Create `packages/core/src/reminders/index.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createDatabase, schema } from '../db/index.js';
import { createNote, updateNote } from '../notes/index.js';
import type { ParsedTag } from '../tags/parser.js';
import {
  cleanupExpiredTrash,
  getPendingReminders,
  markFired,
  normalizeFireAt,
  syncReminders,
} from './index.js';

let sqlite: BetterSqlite3.Database;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(() => {
  const result = createDatabase({ dbPath: ':memory:' });
  sqlite = result.sqlite;
  db = result.db;
});

afterEach(() => {
  sqlite.close();
});

describe('normalizeFireAt', () => {
  test('zeroes seconds and milliseconds', () => {
    // 2026-04-10T15:30:45 → should become 2026-04-10T15:30:00.000 in Unix ms
    const input = new Date(2026, 3, 10, 15, 30, 45, 123).getTime();
    const result = normalizeFireAt(input);
    const d = new Date(result);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
    expect(d.getMinutes()).toBe(30);
    expect(d.getHours()).toBe(15);
  });
});

describe('syncReminders', () => {
  test('creates pending record when note has /alarm tag', () => {
    const note = createNote(db, sqlite, {
      content: 'test',
      tags: [
        { tagType: '/alarm', tagValue: '2026-04-12T15:00:00' },
      ],
    });

    syncReminders(db, sqlite, note.id);

    const pending = getPendingReminders(db);
    expect(pending).toHaveLength(1);
    expect(pending[0].noteId).toBe(note.id);
    expect(pending[0].status).toBe('pending');
    // fire_at should have seconds zeroed
    const d = new Date(pending[0].fireAt);
    expect(d.getSeconds()).toBe(0);
  });

  test('removes reminder when /alarm tag is deleted', () => {
    const note = createNote(db, sqlite, {
      content: 'test',
      tags: [
        { tagType: '/alarm', tagValue: '2026-04-12T15:00:00' },
      ],
    });
    syncReminders(db, sqlite, note.id);
    expect(getPendingReminders(db)).toHaveLength(1);

    // Update note without alarm tag
    updateNote(db, sqlite, note.id, { content: 'test', tags: [] });
    syncReminders(db, sqlite, note.id);

    expect(getPendingReminders(db)).toHaveLength(0);
  });

  test('updates fire_at when alarm time changes', () => {
    const note = createNote(db, sqlite, {
      content: 'test',
      tags: [
        { tagType: '/alarm', tagValue: '2026-04-12T15:00:00' },
      ],
    });
    syncReminders(db, sqlite, note.id);

    updateNote(db, sqlite, note.id, {
      content: 'test',
      tags: [{ tagType: '/alarm', tagValue: '2026-04-13T10:00:00' }],
    });
    syncReminders(db, sqlite, note.id);

    const pending = getPendingReminders(db);
    expect(pending).toHaveLength(1);
    const d = new Date(pending[0].fireAt);
    expect(d.getDate()).toBe(13);
    expect(d.getHours()).toBe(10);
  });

  test('ignores /time tags (only tracks /alarm)', () => {
    const note = createNote(db, sqlite, {
      content: 'test',
      tags: [
        { tagType: '/time', tagValue: '2026-04-12T15:00:00' },
      ],
    });
    syncReminders(db, sqlite, note.id);

    expect(getPendingReminders(db)).toHaveLength(0);
  });
});

describe('markFired', () => {
  test('updates status to fired with timestamp', () => {
    const note = createNote(db, sqlite, {
      content: 'test',
      tags: [{ tagType: '/alarm', tagValue: '2026-04-12T15:00:00' }],
    });
    syncReminders(db, sqlite, note.id);

    const pending = getPendingReminders(db);
    const now = Date.now();
    markFired(db, pending[0].noteId, pending[0].tagId, now);

    const remaining = getPendingReminders(db);
    expect(remaining).toHaveLength(0);
  });
});

describe('cleanupExpiredTrash', () => {
  test('permanently deletes notes trashed over 30 days ago', () => {
    const note = createNote(db, sqlite, { content: 'old trash' });
    // Manually set trashedAt to 31 days ago
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    sqlite.prepare(
      'UPDATE notes SET trash_level = 2, trashed_at = ? WHERE id = ?'
    ).run(thirtyOneDaysAgo.getTime(), note.id);

    const deleted = cleanupExpiredTrash(db, sqlite, 30);
    expect(deleted).toBe(1);
  });

  test('does not delete recently trashed notes', () => {
    const note = createNote(db, sqlite, { content: 'recent trash' });
    sqlite.prepare(
      'UPDATE notes SET trash_level = 2, trashed_at = ? WHERE id = ?'
    ).run(Date.now(), note.id);

    const deleted = cleanupExpiredTrash(db, sqlite, 30);
    expect(deleted).toBe(0);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm --filter @owl/core test -- src/reminders/index.test.ts`
Expected: FAIL (module not found)

**Step 3: Implement `packages/core/src/reminders/index.ts`**

```typescript
import { and, eq, lte, sql } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { OwlDatabase } from '../db/index.js';
import { notes, noteTags, reminderStatus, tags } from '../db/schema.js';

export interface ReminderRecord {
  noteId: string;
  tagId: string;
  fireAt: number;
  status: string;
  firedAt: number | null;
}

/**
 * Zero out seconds and milliseconds from a Unix-ms timestamp.
 */
export function normalizeFireAt(unixMs: number): number {
  const d = new Date(unixMs);
  d.setSeconds(0, 0);
  return d.getTime();
}

/**
 * Parse an ISO-like tag value (e.g. "2026-04-12T15:00:00") into Unix ms,
 * normalized (seconds + ms zeroed).
 */
function tagValueToFireAt(tagValue: string): number | null {
  const d = new Date(tagValue);
  if (Number.isNaN(d.getTime())) return null;
  return normalizeFireAt(d.getTime());
}

/**
 * Sync reminder_status for a given note based on its current /alarm tags.
 * Call this after creating or updating a note.
 *
 * Strategy: delete all existing reminder_status for this note, then re-insert
 * for each current /alarm tag that is still pending (not yet fired or time changed).
 */
export function syncReminders(
  db: OwlDatabase,
  _sqlite: Database.Database,
  noteId: string,
): void {
  // Get current /alarm tags for this note
  const alarmTags = db
    .select({ tagId: noteTags.tagId, tagValue: tags.tagValue })
    .from(noteTags)
    .innerJoin(tags, eq(noteTags.tagId, tags.id))
    .where(and(eq(noteTags.noteId, noteId), eq(tags.tagType, '/alarm')))
    .all();

  // Get existing reminder_status for this note
  const existing = db
    .select()
    .from(reminderStatus)
    .where(eq(reminderStatus.noteId, noteId))
    .all();

  const existingByTagId = new Map(existing.map((r) => [r.tagId, r]));
  const currentTagIds = new Set(alarmTags.map((t) => t.tagId));

  // Delete reminders for tags that no longer exist
  for (const [tagId] of existingByTagId) {
    if (!currentTagIds.has(tagId)) {
      db.delete(reminderStatus)
        .where(and(eq(reminderStatus.noteId, noteId), eq(reminderStatus.tagId, tagId)))
        .run();
    }
  }

  // Upsert reminders for current alarm tags
  for (const tag of alarmTags) {
    if (!tag.tagValue) continue;
    const fireAt = tagValueToFireAt(tag.tagValue);
    if (fireAt === null) continue;

    const existingRecord = existingByTagId.get(tag.tagId);

    if (!existingRecord) {
      // New alarm → insert pending
      db.insert(reminderStatus)
        .values({ noteId, tagId: tag.tagId, fireAt, status: 'pending', firedAt: null })
        .run();
    } else if (existingRecord.fireAt !== fireAt) {
      // Time changed → reset to pending
      db.update(reminderStatus)
        .set({ fireAt, status: 'pending', firedAt: null })
        .where(and(eq(reminderStatus.noteId, noteId), eq(reminderStatus.tagId, tag.tagId)))
        .run();
    }
    // If same time and already fired → leave as-is
  }
}

/**
 * Get all pending reminders, ordered by fire_at ascending.
 */
export function getPendingReminders(db: OwlDatabase): ReminderRecord[] {
  return db
    .select()
    .from(reminderStatus)
    .where(eq(reminderStatus.status, 'pending'))
    .orderBy(reminderStatus.fireAt)
    .all();
}

/**
 * Get overdue pending reminders (fire_at <= now).
 */
export function getOverdueReminders(db: OwlDatabase, now: number = Date.now()): ReminderRecord[] {
  return db
    .select()
    .from(reminderStatus)
    .where(and(eq(reminderStatus.status, 'pending'), lte(reminderStatus.fireAt, now)))
    .orderBy(reminderStatus.fireAt)
    .all();
}

/**
 * Mark a reminder as fired.
 */
export function markFired(db: OwlDatabase, noteId: string, tagId: string, firedAt: number): void {
  db.update(reminderStatus)
    .set({ status: 'fired', firedAt })
    .where(and(eq(reminderStatus.noteId, noteId), eq(reminderStatus.tagId, tagId)))
    .run();
}

/**
 * Get the next pending reminder (earliest fire_at).
 */
export function getNextPendingReminder(db: OwlDatabase): ReminderRecord | null {
  return (
    db
      .select()
      .from(reminderStatus)
      .where(eq(reminderStatus.status, 'pending'))
      .orderBy(reminderStatus.fireAt)
      .limit(1)
      .get() ?? null
  );
}

/**
 * Get note title (first non-empty line of content) for a given note ID.
 */
export function getNoteTitle(db: OwlDatabase, noteId: string): string {
  const note = db.select({ content: notes.content }).from(notes).where(eq(notes.id, noteId)).get();
  if (!note) return 'Untitled';
  const firstLine = note.content.split('\n').find((l) => l.trim().length > 0);
  return firstLine?.trim() ?? 'Untitled';
}

/**
 * Permanently delete trash-level-2 notes older than `days` days.
 * Returns the number of deleted notes.
 */
export function cleanupExpiredTrash(
  db: OwlDatabase,
  _sqlite: Database.Database,
  days: number,
): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  const expired = db
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.trashLevel, 2), lte(notes.trashedAt, new Date(cutoff))))
    .all();

  for (const note of expired) {
    db.delete(notes).where(eq(notes.id, note.id)).run();
  }

  return expired.length;
}
```

**Step 4: Export from `packages/core/src/index.ts`**

Add at the end:

```typescript
// Reminders
export {
  syncReminders,
  getPendingReminders,
  getOverdueReminders,
  getNextPendingReminder,
  markFired,
  getNoteTitle,
  normalizeFireAt,
  cleanupExpiredTrash,
} from './reminders/index.js';
export type { ReminderRecord } from './reminders/index.js';
```

**Step 5: Run tests**

Run: `pnpm --filter @owl/core test`
Expected: All tests PASS (existing 53 + new ~7)

**Step 6: Commit**

```
feat(reminders): add syncReminders, pending queries, and trash cleanup
```

---

### Task 3: Install node-notifier and create notification module

**Files:**
- Modify: `packages/daemon/package.json`
- Create: `packages/daemon/src/notify.ts`

**Step 1: Install node-notifier**

Run: `cd /Users/jayncp/Desktop/jayncp_mac/orpheus-aviary/owl && pnpm --filter @owl/daemon add node-notifier && pnpm --filter @owl/daemon add -D @types/node-notifier`

**Step 2: Create `packages/daemon/src/notify.ts`**

```typescript
import notifier from 'node-notifier';
import type { Logger } from '@owl/core';

export interface NotifyOptions {
  title: string;
  body: string;
}

export function sendNotification(options: NotifyOptions, logger: Logger): void {
  const { title, body } = options;

  notifier.notify(
    {
      title,
      message: body,
      sound: true,
    },
    (err) => {
      if (err) {
        logger.error({ err }, 'Failed to send notification');
      }
    },
  );

  logger.info({ title, body }, 'Notification sent');
}
```

**Step 3: Commit**

```
feat(daemon): add node-notifier notification module
```

---

### Task 4: Create the daemon scheduler

**Files:**
- Create: `packages/daemon/src/scheduler.ts`

**Step 1: Implement the scheduler**

```typescript
import {
  getNextPendingReminder,
  getNoteTitle,
  getOverdueReminders,
  markFired,
  cleanupExpiredTrash,
  syncReminders,
  getPendingReminders,
  type OwlDatabase,
  type Logger,
  type ReminderRecord,
  schema,
} from '@owl/core';
import { and, eq } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import { sendNotification } from './notify.js';

export class ReminderScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastCheckTime = Date.now();
  private readonly HEARTBEAT_MS = 5_000;
  private readonly SLEEP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private db: OwlDatabase,
    private sqlite: Database.Database,
    private logger: Logger,
  ) {}

  /**
   * Start the scheduler: scan overdue, schedule next, start heartbeat.
   */
  start(): void {
    this.logger.info('Reminder scheduler starting');
    this.scanOverdue();
    this.scheduleNext();
    this.startHeartbeat();
  }

  /**
   * Stop the scheduler: clear all timers.
   */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.logger.info('Reminder scheduler stopped');
  }

  /**
   * Scan for overdue pending reminders. Fire notifications and mark as fired.
   * Also handles frequency modifiers (/daily, /weekly, etc.) by creating next pending.
   * Also cleans up expired trash (Tab 2, 30 days).
   */
  scanOverdue(): void {
    const now = Date.now();
    const overdue = getOverdueReminders(this.db, now);

    for (const reminder of overdue) {
      const title = getNoteTitle(this.db, reminder.noteId);
      const fireDate = new Date(reminder.fireAt);
      const timeStr = `${fireDate.getHours().toString().padStart(2, '0')}:${fireDate.getMinutes().toString().padStart(2, '0')}`;

      sendNotification(
        { title, body: `Reminder: ${timeStr}` },
        this.logger,
      );

      markFired(this.db, reminder.noteId, reminder.tagId, now);

      // Handle frequency modifiers: create next pending
      this.handleFrequency(reminder);
    }

    if (overdue.length > 0) {
      this.logger.info({ count: overdue.length }, 'Fired overdue reminders');
    }

    // Trash cleanup
    const trashDeleted = cleanupExpiredTrash(this.db, this.sqlite, 30);
    if (trashDeleted > 0) {
      this.logger.info({ count: trashDeleted }, 'Cleaned up expired trash');
    }
  }

  /**
   * Schedule a setTimeout for the next pending reminder.
   */
  scheduleNext(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const next = getNextPendingReminder(this.db);
    if (!next) {
      this.logger.debug('No pending reminders to schedule');
      return;
    }

    const delay = Math.max(0, next.fireAt - Date.now());
    this.logger.info(
      { noteId: next.noteId, fireAt: new Date(next.fireAt).toISOString(), delayMs: delay },
      'Scheduling next reminder',
    );

    this.timer = setTimeout(() => {
      this.scanOverdue();
      this.scheduleNext();
    }, delay);
  }

  /**
   * Called after a note is created/updated/deleted. Re-syncs reminders and reschedules.
   */
  onNoteChanged(noteId: string): void {
    syncReminders(this.db, this.sqlite, noteId);
    this.scheduleNext();
  }

  /**
   * Handle frequency modifiers: if the note has /daily, /weekly, /monthly, or /yearly,
   * create the next pending reminder_status record.
   */
  private handleFrequency(fired: ReminderRecord): void {
    // Check what frequency tags the note has
    const freqTags = this.db
      .select({ tagType: schema.tags.tagType })
      .from(schema.noteTags)
      .innerJoin(schema.tags, eq(schema.noteTags.tagId, schema.tags.id))
      .where(
        and(
          eq(schema.noteTags.noteId, fired.noteId),
          eq(schema.tags.tagType, '/daily'),
        ),
      )
      .all();

    // Check each frequency type
    const noteFreqs = this.db
      .select({ tagType: schema.tags.tagType })
      .from(schema.noteTags)
      .innerJoin(schema.tags, eq(schema.noteTags.tagId, schema.tags.id))
      .where(eq(schema.noteTags.noteId, fired.noteId))
      .all()
      .filter((t) =>
        ['/daily', '/weekly', '/monthly', '/yearly'].includes(t.tagType),
      );

    if (noteFreqs.length === 0) return;

    // Use the highest priority frequency
    const freqPriority = ['/daily', '/weekly', '/monthly', '/yearly'];
    const activeFreq = freqPriority.find((f) =>
      noteFreqs.some((nf) => nf.tagType === f),
    );
    if (!activeFreq) return;

    const nextFireAt = this.computeNextFireAt(fired.fireAt, activeFreq);

    // Insert new pending record (reuse the same tag)
    this.db
      .insert(schema.reminderStatus)
      .values({
        noteId: fired.noteId,
        tagId: fired.tagId,
        fireAt: nextFireAt,
        status: 'pending',
        firedAt: null,
      })
      .onConflictDoUpdate({
        target: [schema.reminderStatus.noteId, schema.reminderStatus.tagId],
        set: { fireAt: nextFireAt, status: 'pending', firedAt: null },
      })
      .run();

    this.logger.info(
      { noteId: fired.noteId, freq: activeFreq, nextFireAt: new Date(nextFireAt).toISOString() },
      'Created next recurring reminder',
    );
  }

  private computeNextFireAt(currentFireAt: number, freq: string): number {
    const d = new Date(currentFireAt);
    switch (freq) {
      case '/daily':
        d.setDate(d.getDate() + 1);
        break;
      case '/weekly':
        d.setDate(d.getDate() + 7);
        break;
      case '/monthly':
        d.setMonth(d.getMonth() + 1);
        break;
      case '/yearly':
        d.setFullYear(d.getFullYear() + 1);
        break;
    }
    return d.getTime();
  }

  private startHeartbeat(): void {
    this.lastCheckTime = Date.now();

    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      const delta = now - this.lastCheckTime;

      if (delta > this.SLEEP_THRESHOLD_MS) {
        this.logger.info(
          { deltaMs: delta },
          'Detected system wake from sleep, scanning overdue',
        );
        this.scanOverdue();
        this.scheduleNext();
      }

      this.lastCheckTime = now;
    }, this.HEARTBEAT_MS);
  }
}
```

**Step 2: Commit**

```
feat(daemon): add ReminderScheduler with heartbeat and frequency support
```

---

### Task 5: Integrate scheduler into daemon startup + routes

**Files:**
- Modify: `packages/daemon/src/context.ts`
- Modify: `packages/daemon/src/cli.ts`
- Modify: `packages/daemon/src/server.ts`
- Modify: `packages/daemon/src/routes/notes.ts`

**Step 1: Add scheduler to AppContext**

In `packages/daemon/src/context.ts`, add:

```typescript
import type { ReminderScheduler } from './scheduler.js';
```

And add to the interface:

```typescript
scheduler: ReminderScheduler;
```

**Step 2: Create scheduler in daemon startup (`cli.ts`)**

After `const deviceId = ensureDeviceId(db);` and before `const server = buildServer(...)`, add:

```typescript
import { ReminderScheduler } from './scheduler.js';

// ...inside daemon action:
const scheduler = new ReminderScheduler(db, sqlite, logger);
```

Pass `scheduler` to `buildServer`:

```typescript
const server = buildServer({ db, sqlite, config, logger, deviceId, scheduler });
```

After `server.listen(...)` succeeds, start the scheduler:

```typescript
scheduler.start();
```

In `shutdown()`, stop the scheduler before closing server:

```typescript
scheduler.stop();
```

**Step 3: Call `scheduler.onNoteChanged()` in note routes**

In `packages/daemon/src/routes/notes.ts`:

After `createNote()` call (POST /notes), add:
```typescript
ctx.scheduler.onNoteChanged(note.id);
```

After `updateNote()` call (PUT /notes/:id), add:
```typescript
ctx.scheduler.onNoteChanged(note.id);
```

After `updateNote()` call (PATCH /notes/:id), add:
```typescript
if (note) ctx.scheduler.onNoteChanged(note.id);
```

After `deleteNote()` (DELETE /notes/:id), add:
```typescript
ctx.scheduler.onNoteChanged(id);
```

After `restoreNote()` (POST /notes/:id/restore), add:
```typescript
ctx.scheduler.onNoteChanged(id);
```

**Step 4: Run typecheck + lint**

Run: `cd /Users/jayncp/Desktop/jayncp_mac/orpheus-aviary/owl && just check`
Expected: Zero errors

**Step 5: Commit**

```
feat(daemon): integrate scheduler into startup and note routes
```

---

### Task 6: Add daemon-level tests for scheduler integration

**Files:**
- Modify: `packages/daemon/src/server.test.ts`

**Step 1: Read existing test setup**

Read `packages/daemon/src/server.test.ts` to understand the test harness.

**Step 2: Add scheduler integration tests**

Add to the existing test file:

```typescript
describe('reminder scheduler integration', () => {
  test('POST /notes with /alarm tag creates pending reminder_status', async () => {
    const futureTime = new Date(Date.now() + 3600_000); // 1 hour from now
    const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
    const alarmValue = `/alarm ${pad(futureTime.getFullYear(), 4)}-${pad(futureTime.getMonth() + 1)}-${pad(futureTime.getDate())} ${pad(futureTime.getHours())}:${pad(futureTime.getMinutes())}`;

    const res = await app.inject({
      method: 'POST',
      url: '/notes',
      payload: {
        content: 'reminder test',
        tags: [alarmValue],
      },
    });

    expect(res.statusCode).toBe(201);
    const noteId = res.json().data.id;

    // Check reminder_status table
    const rows = sqlite.prepare(
      'SELECT * FROM reminder_status WHERE note_id = ?'
    ).all(noteId);
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).status).toBe('pending');
  });

  test('DELETE /notes/:id removes reminder_status (CASCADE)', async () => {
    const futureTime = new Date(Date.now() + 3600_000);
    const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
    const alarmValue = `/alarm ${pad(futureTime.getFullYear(), 4)}-${pad(futureTime.getMonth() + 1)}-${pad(futureTime.getDate())} ${pad(futureTime.getHours())}:${pad(futureTime.getMinutes())}`;

    const createRes = await app.inject({
      method: 'POST',
      url: '/notes',
      payload: { content: 'to delete', tags: [alarmValue] },
    });
    const noteId = createRes.json().data.id;

    // Permanent delete to trigger CASCADE
    await app.inject({
      method: 'POST',
      url: `/notes/${noteId}/permanent-delete`,
    });

    const rows = sqlite.prepare(
      'SELECT * FROM reminder_status WHERE note_id = ?'
    ).all(noteId);
    expect(rows).toHaveLength(0);
  });
});
```

**Step 3: Run tests**

Run: `pnpm --filter @owl/daemon test`
Expected: All tests PASS

**Step 4: Commit**

```
test(daemon): add scheduler integration tests for reminder routes
```

---

### Task 7: Final verification

**Step 1: Run full test suite**

Run: `cd /Users/jayncp/Desktop/jayncp_mac/orpheus-aviary/owl && pnpm test`
Expected: All tests pass

**Step 2: Run lint + typecheck**

Run: `just check`
Expected: Zero errors

**Step 3: Update PROCESS.md**

Mark P1-10 as completed. Move "下一步" to P2 planning.

**Step 4: Commit**

```
docs(owl): mark P1-10 complete in PROCESS.md
```

---

## Summary

| Task | Description | New/Modified Files |
|------|-------------|-------------------|
| 1 | reminder_status table schema + DDL | schema.ts, db/index.ts |
| 2 | Core reminder sync/query logic + tests | reminders/index.ts, reminders/index.test.ts, core/index.ts |
| 3 | node-notifier + notify module | package.json, notify.ts |
| 4 | ReminderScheduler class | scheduler.ts |
| 5 | Integrate scheduler into daemon + routes | context.ts, cli.ts, server.ts, routes/notes.ts |
| 6 | Daemon integration tests | server.test.ts |
| 7 | Final verification + docs | PROCESS.md |
