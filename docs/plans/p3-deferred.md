# P3 Deferred — Design Notes

Collection of UX / design decisions we've talked about but aren't
implementing in P2. Captured here so P3 planning has a concrete list to
pull from instead of re-deriving it from conversation scrollback.

## New feature ideas (2026-04-18)

### Autocomplete (编辑器内自动补全)

**Scope TBD**. Candidate signals to autocomplete on:
- `#` prefix → tag name suggestions from existing tags
- `/time ` / `/alarm ` → datetime chunks (today, tomorrow, "HH:MM")
- `[[` → note-link to another note by title (requires a note-link syntax we don't have yet)
- `@` → AI slash-commands or note-mentions
- Frequently-used phrases from user's own content (corpus-based)

**Open questions**:
- Which triggers? Start with tags since existing `tag-store` already has them.
- CodeMirror 6 has `@codemirror/autocomplete` built-in — we already load it
  for bracket-matching but don't feed it any source. Adding one `CompletionSource`
  per trigger is low-risk.
- Ordering: pinyin-first for Chinese tags (same sort as tag bar).

**Not doing until user confirms scope.**

### AI chat → 打开指定笔记

**Scope**: when the AI mentions a note by id / title in its reply, surface
an inline link / button so the user can click to jump to that note in the
editor.

**Implementation sketch**:
- In `MessageBubble`, post-process assistant `content` markdown to detect
  note-id patterns (UUIDs from `list_notes` / `search_notes` results AI paraphrases).
- OR: add a structured "note citation" field to the assistant message —
  daemon could attach `referenced_note_ids` on `message` events based on
  which tool results the assistant quoted. More precise, more work.
- On click → `openNoteById(id)` + `navigate('/')`.

**Alternative**: add an explicit `open_note` tool the AI calls when the
user asks "take me to X" — result card has an Open button, mirrors
DraftReadyCard's pattern. Simpler but requires AI to recognise the intent.

## Carried over from P2 "not doing" list

### `open_note_in_gui` (daemon → GUI reverse channel)

Originally scoped for P2 but dropped — only needed when external CLI
agents want to make the GUI jump to a note. Blocked on no daemon→GUI
push mechanism. P3 can add this via a small WebSocket / long-poll when
CLI integration (also P3) starts needing it.

### Remote daemon connection

Old P2-1 scope. Dropped because it's tightly coupled with migration sync
semantics. **Moved to P4** (with the migration CLI rewrite), not P3.

### Semantic search / embeddings

From P2-7 design decisions. Current AI agent uses FTS5 trigram + LLM
query expansion (two-layer search). Embedding would add: `note_chunks`
table, async indexing queue, top-k cosine similarity. Designed as optional
layer that degrades to FTS when unavailable. P3 can pull this in when
FTS ranking quality starts biting.

## Special notes

### Visual distinction

**Context**: `#随记` (id `…0001`) and `#待办` (id `…0002`) are system-managed
notes that `ensureSpecialNotes` auto-creates / auto-restores. They currently
appear in the note list mixed with regular notes — no visual cue.

**P3 design** (to be refined):

- Pin them to the top of the list (`ORDER BY is_special DESC, updated_at DESC`)
  OR promote to a dedicated "系统" section above the sorted-by-time section.
- Visual distinction: a small 📌 / ⭐ badge next to the title, subtle tinted
  background, or colored left border. Need to pick one; avoid stacking too
  many signals.
- Side-nav shortcut buttons — one-click jump to memo / todo — maybe, maybe not.
  Currently the dedicated `/todo` page already covers the todo note via
  content parsing, so a shortcut to the memo note is the main win.
- Protections already in place (don't redo): deleteNote / permanentDelete
  refuse; ensureSpecialNotes restores from trash on startup.

**Open questions**:
- Should the user be allowed to rename the displayed title? (DB content is
  user-editable; the "title" is just the first H1, so this already works.)
- What happens to folder moves? Currently allowed. P3 could pin them to root.

### `append_memo` semantics

`append_memo` hardcodes the special memo id. If the user has their own
`#memo`-tagged note, there's a semantic mismatch. P3 options:

1. Keep `append_memo` targeting the special note, but advertise this clearly
   (tool description + UI hint when the user creates a `#memo` tag).
2. Change the tool to search for `#memo` tagged notes and write to the most
   recently updated one; fall back to the special note if none exist. More
   flexible, more surprise potential.
3. Split: `append_memo` → special note, `append_to_tagged` → user-chosen tag.

## Chat persistence details deferred to P3

The `2026-04-18-chat-persistence.md` plan lists explicit out-of-scope items;
most of them belong here if they become priorities:

- Last-message preview under each sidebar entry.
- Unread indicators.
- Full-text search inside messages.
- Export conversations (Markdown / JSON).
- Per-conversation folder tagging (organize history).
- DraftReadyCard / note_applied event replay on history load.

## AI draft UX alternative — banner instead of stage-overwrite

Discussed during P2-8 step 9. Current behavior: clicking "打开" on a
DraftReadyCard immediately overwrites the tab's content with the AI
version (and captures the user's pre-stage content for conflict rollback).

**Alternative (option C from the discussion)**: `stageAiUpdate` stashes
the pending payload without overwriting tab.content; the editor shows
a top banner "AI 提议了修改 [查看差异]" that opens ConflictDialog.
Cleaner and closer to Claude web, but requires a banner component and
conditional rendering in EditorPanel.

Deferred until we have a concrete UX complaint driving it.
