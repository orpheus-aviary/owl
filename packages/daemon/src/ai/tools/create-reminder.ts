import { randomUUID } from 'node:crypto';
import { parseTag } from '@owl/core';
import type { ToolDef } from '../tool-registry.js';
import { buildDraftResult, buildPreviewResult, renderDiff } from './_tier2-shared.js';
import { getNullableString, getStringArray, requireString } from './args.js';

export const createReminderTool: ToolDef = {
  name: 'create_reminder',
  description:
    'Draft a new note that fires a reminder at a specific time. Tier-2 write: nothing is ' +
    "persisted yet. The /alarm tag is synthesized from `fire_at`, so don't include one in `tags`. " +
    'Use this when the user asks to "remind me" / "提醒我" / "set an alarm".',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Body of the reminder note (e.g. "buy milk").' },
      fire_at: {
        type: 'string',
        description:
          'When to fire, ISO-ish (YYYY-MM-DDTHH:MM:SS, "YYYY-MM-DD HH:MM", etc). Local time.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Extra tags (e.g. ["#家事"]). Do NOT include /alarm — it is auto-added.',
      },
      folder_id: {
        type: ['string', 'null'],
        description: 'Target folder id; null or omitted = root/unfiled.',
      },
    },
    required: ['content', 'fire_at'],
  },
  async execute(args, ctx) {
    const content = requireString(args, 'content');
    const fireAt = requireString(args, 'fire_at');
    const extraTags = getStringArray(args, 'tags') ?? [];
    const folderId = getNullableString(args, 'folder_id') ?? null;

    // Use the same parser the GUI uses so the alarm tag value is normalized
    // exactly like a user-typed `/alarm 2026-04-20 10:00` would be.
    const parsed = parseTag(`/alarm ${fireAt}`);
    if (!parsed || !parsed.tagValue) {
      throw new Error(`fire_at could not be parsed as a date/time: ${fireAt}`);
    }
    const alarmTag = `/alarm ${parsed.tagValue}`;
    const tags = [alarmTag, ...extraTags.filter((t) => !t.startsWith('/alarm'))];

    if (ctx.source === 'external') {
      const stored = ctx.previewStore.create({
        action: 'create_reminder',
        content,
        tags,
        folder_id: folderId,
      });
      const diff = renderDiff(
        { content: '', tags: [], folder_id: null },
        { content, tags, folder_id: folderId },
      );
      return buildPreviewResult({
        preview_id: stored.id,
        action: 'create_reminder',
        diff,
        content,
        tags,
        folder_id: folderId,
      });
    }

    return buildDraftResult({
      action: 'create_reminder',
      note_id: `draft_${randomUUID()}`,
      content,
      tags,
      folder_id: folderId,
    });
  },
};
