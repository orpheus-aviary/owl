import { getNote } from '@owl/core';
import type { ToolDef } from '../tool-registry.js';
import { buildDraftResult, buildPreviewResult, formatTags, renderDiff } from './_tier2-shared.js';
import { getNullableString, getString, getStringArray, requireString } from './args.js';

export const updateNoteTool: ToolDef = {
  name: 'update_note',
  description:
    'Draft an edit to an existing note. Tier-2 write: the change is staged for user review (GUI ' +
    'tab or preview store), never written directly. At least one of `content`, `tags`, or ' +
    '`folder_id` must be provided. Returns the original DB values as baselines so the GUI can ' +
    'detect concurrent edits at save time.',
  parameters: {
    type: 'object',
    properties: {
      note_id: { type: 'string', description: 'ID of the note to update.' },
      content: { type: 'string', description: 'New full markdown body. Omit to keep existing.' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replacement tag list. Omit to keep existing.',
      },
      folder_id: {
        type: ['string', 'null'],
        description: 'New folder id, or null for root. Omit to keep existing.',
      },
    },
    required: ['note_id'],
  },
  async execute(args, ctx) {
    const noteId = requireString(args, 'note_id');
    const newContent = getString(args, 'content');
    const newTagsRaw = getStringArray(args, 'tags');
    // Distinguish "omit" (undefined) from "set to root" (null).
    const folderProvided = 'folder_id' in args;
    const newFolderId = folderProvided ? (getNullableString(args, 'folder_id') ?? null) : undefined;

    if (newContent === undefined && newTagsRaw === undefined && !folderProvided) {
      throw new Error('update_note requires at least one of content, tags, or folder_id');
    }

    const existing = getNote(ctx.db, noteId);
    if (!existing) {
      return { error: `Note not found: ${noteId}` };
    }

    const originalTags = formatTags(existing);
    const originalFolderId = existing.folderId;
    const originalContent = existing.content;

    const finalContent = newContent ?? originalContent;
    const finalTags = newTagsRaw ?? originalTags;
    const finalFolderId = folderProvided ? (newFolderId as string | null) : originalFolderId;

    if (ctx.source === 'external') {
      const stored = ctx.previewStore.create({
        action: 'update',
        note_id: noteId,
        content: finalContent,
        tags: finalTags,
        folder_id: finalFolderId,
      });
      const diff = renderDiff(
        { content: originalContent, tags: originalTags, folder_id: originalFolderId },
        { content: finalContent, tags: finalTags, folder_id: finalFolderId },
      );
      return buildPreviewResult({
        preview_id: stored.id,
        action: 'update',
        diff,
        content: finalContent,
        tags: finalTags,
        folder_id: finalFolderId,
      });
    }

    return buildDraftResult({
      action: 'update',
      note_id: noteId,
      content: finalContent,
      tags: finalTags,
      folder_id: finalFolderId,
      original_content: originalContent,
      original_tags: originalTags,
      original_folder_id: originalFolderId,
    });
  },
};
