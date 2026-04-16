import type { AiConfig, NoteWithTags, OwlDatabase } from '@owl/core';
import { listNotes } from '@owl/core';
import type Database from 'better-sqlite3';

const PERSONA = `You are Owl, an AI assistant embedded in the user's personal note-taking app.

You can read the user's notes, tags, folders, reminders, and todos. You can also \
write to a small "memo" scratchpad and add quick todo items directly. For anything \
larger (creating or updating full notes, scheduling reminders) you draft changes \
which the user reviews before saving.

Important behaviour rules:
- Be concise. The user usually wants quick answers, not essays.
- Match the user's language. If they message in Chinese, reply in Chinese.
- Trust the recent-notes context block below for short queries; only call \
  \`search_notes\` when the answer is not already there.
- Quote note IDs (\`abc123\`) when referencing specific notes so the user can \
  jump to them.
- Tier-1 writes (\`append_memo\`, \`add_todo\`) commit immediately; warn the user \
  beforehand only if the change is non-obvious or destructive.`;

/**
 * Build the full system prompt: persona + current date/time + Layer-1
 * recent-notes context. Called once per user turn so the date/time stays
 * fresh and the recent-notes block reflects whatever the user just edited.
 */
export function buildSystemPrompt(
  db: OwlDatabase,
  sqlite: Database.Database,
  config: AiConfig,
): string {
  const now = new Date();
  const dateLine = `Current date/time: ${now.toISOString()} (local: ${now.toString()})`;

  const contextBlock = buildRecentContextBlock(db, sqlite, config);

  return [PERSONA, dateLine, contextBlock].join('\n\n');
}

/**
 * Layer-1 "recent fill": pull the N most-recently-updated notes and inline
 * them in the system prompt up to a cumulative `max_context_chars` budget.
 * Notes that don't fit are dropped silently — the LLM can call
 * `search_notes` (Layer 2) when it needs more.
 *
 * Each note is rendered as `<note id="..." tags="..." updated="...">…</note>`
 * so the LLM sees a stable shape it can reference back to.
 */
export function buildRecentContextBlock(
  db: OwlDatabase,
  sqlite: Database.Database,
  config: AiConfig,
): string {
  const { items } = listNotes(db, sqlite, {
    sortBy: 'updated',
    sortOrder: 'desc',
    limit: config.max_recent_notes,
  });

  if (items.length === 0) {
    return '## Recent notes\n\n(no notes yet)';
  }

  const rendered: string[] = [];
  let consumed = 0;
  for (const note of items) {
    const block = renderNoteBlock(note);
    if (consumed > 0 && consumed + block.length > config.max_context_chars) break;
    rendered.push(block);
    consumed += block.length;
  }

  return `## Recent notes (${rendered.length} of ${items.length} most-recent)\n\n${rendered.join('\n\n')}`;
}

function renderNoteBlock(note: NoteWithTags): string {
  const tagAttr = note.tags
    .map((t) => (t.tagType === '#' ? `#${t.tagValue ?? ''}` : `${t.tagType} ${t.tagValue ?? ''}`))
    .join(' ');
  const folderAttr = note.folderId ?? '';
  return [
    `<note id="${note.id}" folder="${folderAttr}" tags="${escapeAttr(tagAttr)}" updated="${note.updatedAt.toISOString()}">`,
    note.content,
    '</note>',
  ].join('\n');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
