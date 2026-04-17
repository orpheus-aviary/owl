# P3 Deferred — Design Notes

Collection of UX / design decisions we've talked about but aren't
implementing in P2. Captured here so P3 planning has a concrete list to
pull from instead of re-deriving it from conversation scrollback.

## Special-note visual distinction

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

## Special-note UX in AI tools

`append_memo` hardcodes the special memo id. If the user has their own
`#memo`-tagged note, there's a semantic mismatch. P3 options:

1. Keep `append_memo` targeting the special note, but advertise this clearly
   (tool description + UI hint when the user creates a `#memo` tag).
2. Change the tool to search for `#memo` tagged notes and write to the most
   recently updated one; fall back to the special note if none exist. More
   flexible, more surprise potential.
3. Split: `append_memo` → special note, `append_to_tagged` → user-chosen tag.

Deferred until after P2-10.

## Chat persistence details left to P3

The `2026-04-18-chat-persistence.md` plan lists explicit out-of-scope items;
most of them belong here if they become priorities:

- Last-message preview under each sidebar entry.
- Unread indicators.
- Full-text search inside messages.
- Export conversations (Markdown / JSON).
- Per-conversation folder tagging (organize history).
