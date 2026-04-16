import { randomUUID } from 'node:crypto';
import type { ToolDef } from '../tool-registry.js';
import { buildDraftResult, buildPreviewResult, renderDiff } from './_tier2-shared.js';
import { getNullableString, getStringArray, requireString } from './args.js';

export const createNoteTool: ToolDef = {
  name: 'create_note',
  description:
    'Draft a brand-new note for the user. Tier-2 write: nothing is persisted yet — the GUI ' +
    'opens it as an unsaved tab (source=gui) or it lands in the preview store for the user to ' +
    'review and call `apply_update` (source=external). Use this when the user asks to "create" ' +
    'or "write" a note, not for jotting one-line memos (use `append_memo` for that).',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Full markdown body of the new note.' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Raw tag strings, e.g. ["#工作", "/alarm 2026-04-20T10:00:00"].',
      },
      folder_id: {
        type: ['string', 'null'],
        description: 'Target folder id; null or omitted = root/unfiled.',
      },
    },
    required: ['content'],
  },
  async execute(args, ctx) {
    const content = requireString(args, 'content');
    const tags = getStringArray(args, 'tags') ?? [];
    const folderId = getNullableString(args, 'folder_id') ?? null;

    if (ctx.source === 'external') {
      const stored = ctx.previewStore.create({
        action: 'create',
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
        action: 'create',
        diff,
        content,
        tags,
        folder_id: folderId,
      });
    }

    return buildDraftResult({
      action: 'create',
      note_id: `draft_${randomUUID()}`,
      content,
      tags,
      folder_id: folderId,
    });
  },
};
