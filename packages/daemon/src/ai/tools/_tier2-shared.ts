import type { NoteWithTags } from '@owl/core';
import type { PreviewAction } from '../preview-store.js';
import type { WriteToolResult } from '../tool-registry.js';

/**
 * Helpers shared by the Tier-2 write tools (`create_note`, `update_note`,
 * `create_reminder`). Keeping the diff/format/build logic here avoids
 * three near-identical copies in each tool file.
 */

/** Format `NoteWithTags.tags` as the raw tag-string array used everywhere else. */
export function formatTags(note: NoteWithTags): string[] {
  return note.tags.map((t) => {
    if (t.tagType === '#') return `#${t.tagValue ?? ''}`;
    if (t.tagValue) return `${t.tagType} ${t.tagValue}`;
    return t.tagType;
  });
}

/**
 * Pretty-print the difference between two note states as a plain-text block.
 * Cheaper and easier to audit than a real LCS diff — and the receiver
 * (an external agent or human) only needs a glance to confirm intent.
 */
export function renderDiff(
  before: { content: string; tags: string[]; folder_id?: string | null },
  after: { content: string; tags: string[]; folder_id?: string | null },
): string {
  const sections: string[] = [];
  if (before.content !== after.content) {
    sections.push(
      ['## content', '--- before ---', before.content, '--- after ---', after.content].join('\n'),
    );
  }
  const beforeTags = before.tags.slice().sort().join(' ');
  const afterTags = after.tags.slice().sort().join(' ');
  if (beforeTags !== afterTags) {
    sections.push(`## tags\nbefore: ${beforeTags || '(none)'}\nafter:  ${afterTags || '(none)'}`);
  }
  if (before.folder_id !== after.folder_id) {
    sections.push(
      `## folder\nbefore: ${before.folder_id ?? '(root)'}\nafter:  ${after.folder_id ?? '(root)'}`,
    );
  }
  return sections.length > 0 ? sections.join('\n\n') : '(no changes)';
}

/**
 * Build a Tier-2 success result. The agent loop forwards `sideEffect` into a
 * typed `draft_ready` / `preview_ready` SSE event ahead of the tool result;
 * `message` is the line the LLM sees so it can describe the outcome to the
 * user without double-yielding the payload.
 */
export function buildDraftResult(payload: {
  action: 'create' | 'update' | 'create_reminder';
  note_id: string;
  content: string;
  tags: string[];
  folder_id: string | null;
  original_content?: string;
  original_tags?: string[];
  original_folder_id?: string | null;
}): WriteToolResult {
  return {
    message: `Drafted ${payload.action} for note ${payload.note_id}; awaiting user save.`,
    sideEffect: { type: 'draft_ready', payload },
  };
}

export function buildPreviewResult(payload: {
  preview_id: string;
  action: PreviewAction;
  diff: string;
  content: string;
  tags: string[];
  folder_id?: string | null;
}): WriteToolResult {
  return {
    message: `Stored preview ${payload.preview_id} (${payload.action}); call apply_update to commit.`,
    sideEffect: {
      type: 'preview_ready',
      payload: {
        preview_id: payload.preview_id,
        action: payload.action,
        diff: payload.diff,
        content: payload.content,
        tags: payload.tags,
        folder_id: payload.folder_id,
      },
    },
  };
}
