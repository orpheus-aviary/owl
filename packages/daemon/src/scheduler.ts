import {
  type Logger,
  type OwlConfig,
  type OwlDatabase,
  type ReminderRecord,
  cleanupExpiredTrash,
  getNextPendingReminder,
  getNextTrashDeadline,
  getNoteTitle,
  getOverdueReminders,
  markFired,
  recomputeTrashDeadlines,
  schema,
  syncReminders,
} from '@owl/core';
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { sendNotification } from './notify.js';

const FREQ_PRIORITY: Record<string, number> = {
  '/daily': 0,
  '/weekly': 1,
  '/monthly': 2,
  '/yearly': 3,
};

export class ReminderScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private trashTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastCheckTime: number = Date.now();
  private readonly HEARTBEAT_MS = 5_000;
  private readonly SLEEP_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private readonly db: OwlDatabase,
    private readonly sqlite: Database.Database,
    private readonly config: OwlConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.logger.info('Reminder scheduler starting');
    // Bring any pre-migration level-2 notes (auto_delete_at=NULL) up to date
    // and re-apply the current threshold as a ceiling.
    recomputeTrashDeadlines(this.db, this.config.trash.auto_delete_days);
    this.scanOverdue();
    this.scheduleNext();
    this.scheduleNextTrashCleanup();
    this.startHeartbeat();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.trashTimer) {
      clearTimeout(this.trashTimer);
      this.trashTimer = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.logger.info('Reminder scheduler stopped');
  }

  scanOverdue(): void {
    const overdue = getOverdueReminders(this.db);

    for (const reminder of overdue) {
      const title = getNoteTitle(this.db, reminder.noteId);
      const fireDate = new Date(reminder.fireAt);
      const hh = String(fireDate.getHours()).padStart(2, '0');
      const mm = String(fireDate.getMinutes()).padStart(2, '0');

      sendNotification({ title, body: `Reminder: ${hh}:${mm}` }, this.logger);
      markFired(this.db, reminder.noteId, reminder.tagId, Date.now());
      this.handleFrequency(reminder);
    }

    if (overdue.length > 0) {
      this.logger.info({ count: overdue.length }, 'Fired overdue reminders');
    }

    const deleted = cleanupExpiredTrash(this.db, this.sqlite);
    if (deleted > 0) {
      this.logger.info({ count: deleted }, 'Cleaned up expired trash notes');
    }
  }

  /**
   * Arm a timer for the next `auto_delete_at` deadline. When it fires we run
   * a cleanup pass and recursively schedule the next. Call this after config
   * changes or after soft-deletes to keep the timer accurate. Independent of
   * `scheduleNext()` which is reminder-driven.
   */
  scheduleNextTrashCleanup(): void {
    if (this.trashTimer) {
      clearTimeout(this.trashTimer);
      this.trashTimer = null;
    }

    const nextDeadline = getNextTrashDeadline(this.db);
    if (nextDeadline === null) {
      this.logger.debug('No pending trash deadlines to schedule');
      return;
    }

    const rawDelay = Math.max(0, nextDeadline - Date.now());
    // Node's setTimeout overflows past ~24.8 days (int32 ms). Cap the single
    // timer at 24h and re-check on every tick; this also doubles as a slow
    // heartbeat for trash cleanup.
    const MAX_DELAY = 24 * 60 * 60 * 1000;
    const delay = Math.min(rawDelay, MAX_DELAY);

    this.trashTimer = setTimeout(() => {
      const deleted = cleanupExpiredTrash(this.db, this.sqlite);
      if (deleted > 0) {
        this.logger.info({ count: deleted }, 'Cleaned up expired trash notes (timer)');
      }
      this.scheduleNextTrashCleanup();
    }, delay);

    this.logger.debug(
      { deadline: new Date(nextDeadline).toISOString(), delayMs: delay, rawDelayMs: rawDelay },
      'Scheduled next trash cleanup',
    );
  }

  /**
   * Called by PATCH /config when `trash.auto_delete_days` changes. Pulls
   * deadlines inward (if threshold was lowered) and re-arms the cleanup
   * timer. Never deletes anything immediately — the user's threshold change
   * is treated as a ceiling adjustment, not a destructive action.
   */
  onTrashThresholdChanged(): void {
    recomputeTrashDeadlines(this.db, this.config.trash.auto_delete_days);
    this.scheduleNextTrashCleanup();
  }

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

    const now = Date.now();
    const delay = Math.max(0, next.fireAt - now);

    this.timer = setTimeout(() => {
      this.scanOverdue();
      this.scheduleNext();
    }, delay);

    this.logger.info(
      { fireAt: new Date(next.fireAt).toISOString(), delayMs: delay },
      'Scheduled next reminder',
    );
  }

  onNoteChanged(noteId: string): void {
    syncReminders(this.db, this.sqlite, noteId);
    this.scheduleNext();
    this.scheduleNextTrashCleanup();
  }

  private handleFrequency(fired: ReminderRecord): void {
    const noteFreqs = this.db
      .select({ tagType: schema.tags.tagType })
      .from(schema.noteTags)
      .innerJoin(schema.tags, eq(schema.noteTags.tagId, schema.tags.id))
      .where(eq(schema.noteTags.noteId, fired.noteId))
      .all()
      .filter((t) => ['/daily', '/weekly', '/monthly', '/yearly'].includes(t.tagType));

    if (noteFreqs.length === 0) return;

    // Pick highest priority frequency (daily > weekly > monthly > yearly)
    noteFreqs.sort((a, b) => (FREQ_PRIORITY[a.tagType] ?? 99) - (FREQ_PRIORITY[b.tagType] ?? 99));
    const freq = noteFreqs[0].tagType;

    const nextFireAt = this.computeNextFireAt(fired.fireAt, freq);

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
      { noteId: fired.noteId, freq, nextFireAt: new Date(nextFireAt).toISOString() },
      'Scheduled recurring reminder',
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
      if (now - this.lastCheckTime > this.SLEEP_THRESHOLD_MS) {
        this.logger.info('Detected system wake from sleep');
        this.scanOverdue();
        this.scheduleNext();
      }
      this.lastCheckTime = now;
    }, this.HEARTBEAT_MS);
  }
}
