import { listRemindersWithStatus } from '@owl/core';
import type { ToolDef } from '../tool-registry.js';
import { getNumber, getString } from './args.js';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export const getRemindersTool: ToolDef = {
  name: 'get_reminders',
  description:
    'Return notes with `/alarm` reminders, with the AUTHORITATIVE schedule status from ' +
    '`reminder_status` (pending = not yet fired, overdue = fire time passed but never delivered, ' +
    'fired = already delivered). Optional from/to bound the fire time window (ISO 8601). ' +
    'Trashed notes are excluded.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'overdue', 'fired'],
        description: 'Filter by status. Omit to return all statuses.',
      },
      from: {
        type: 'string',
        description: 'Inclusive lower bound on fire time (ISO 8601 datetime).',
      },
      to: {
        type: 'string',
        description: 'Inclusive upper bound on fire time (ISO 8601 datetime).',
      },
      limit: {
        type: 'number',
        description: `Max records to return (default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}).`,
      },
    },
  },
  async execute(args, ctx) {
    const status = parseStatus(getString(args, 'status'));
    const from = parseTimestamp(getString(args, 'from'), 'from');
    const to = parseTimestamp(getString(args, 'to'), 'to');
    const limit = Math.min(getNumber(args, 'limit') ?? DEFAULT_LIMIT, MAX_LIMIT);

    const rows = listRemindersWithStatus(ctx.db, ctx.sqlite, {
      status,
      from,
      to,
      limit,
    });

    return {
      reminders: rows.map((r) => ({
        note_id: r.noteId,
        note_title: r.noteTitle,
        tag_id: r.tagId,
        fire_at: new Date(r.fireAt).toISOString(),
        status: r.status,
        fired_at: r.firedAt ? new Date(r.firedAt).toISOString() : null,
      })),
    };
  },
};

function parseStatus(raw: string | undefined): 'pending' | 'overdue' | 'fired' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'pending' || raw === 'overdue' || raw === 'fired') return raw;
  throw new Error(`status must be one of pending|overdue|fired (got: ${raw})`);
}

function parseTimestamp(raw: string | undefined, fieldName: string): number | undefined {
  if (raw === undefined) return undefined;
  const ms = new Date(raw).getTime();
  if (Number.isNaN(ms)) throw new Error(`${fieldName} must be a valid ISO 8601 datetime`);
  return ms;
}
