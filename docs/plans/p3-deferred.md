# P3 Deferred — Design Notes

> **Status (2026-05-04)**: Superseded by `2026-04-20-p3-plan.md`. All items
> below have been triaged into that plan's layered phases (P3.4 / P4 / P5 / P6).
> This file is kept as raw material with more detailed sketches — consult the
> main P3 plan first; come here only when you need the longer notes behind a
> phase line item.
>
> **Triage summary (2026-05-04)**:
>
> - **Entered P3.4** with concrete scope (see p3-plan §7):
>   - AI chat → 跳转 (now P3.4-c, 方案 A regex post-processing)
>   - 特殊笔记视觉区分 (now P3.4-b, #随记 蓝边框 / #待办 粉边框)
>   - 编辑器自动补全 (now P3.4-d, **scope shrunk** to TagBar 输入框 Tab/Enter
>     区分; `[[` note-link and 编辑器正文 slash command 都**显式放弃**)
> - **Moved to P6** (non-core, after packaging stabilizes):
>   - `open_note_in_gui` reverse channel (already shipped in P3.2-d)
>   - `append_memo` semantics
>   - AI draft banner option C
>   - `[[` note-link syntax + render + 反向链接
>   - 编辑器正文 slash command 触发器
> - **Moved to P4**:
>   - Remote daemon connection
>   - Semantic search / embeddings (evaluate; FTS 够用则不做)

Collection of UX / design decisions we've talked about but aren't
implementing in P2. Captured here so P3 planning has a concrete list to
pull from instead of re-deriving it from conversation scrollback.

## New feature ideas (2026-04-18)

### Autocomplete (编辑器内自动补全)

**Status (2026-05-04)**: scope **shrunk**. P3.4-d 只做 TagBar 输入框的
Tab/Enter 区分（Tab = 纯补全字面量不触发 picker；Enter = 补全 + picker）。
**Not doing** in P3.4:

- `[[` note-link 补全（owl 无 wikilink 语法，语法 + 渲染 + 反向链接面板
  本身就是大工程，移至 P6）
- 编辑器正文内的 slash command 触发器（CodeMirror extension 改造大，移至 P6）
- 频繁短语补全 / 语料库挖掘（未排期）

**Candidate signals still unaddressed**（P6 再考虑）:
- `[[` → note-link to another note by title (requires a note-link syntax we don't have yet)
- `@` → AI slash-commands or note-mentions
- Frequently-used phrases from user's own content (corpus-based)

### AI chat → 打开指定笔记

**Status (2026-05-04)**: moved to P3.4-c with concrete scope:

- 方案 A: GUI regex post-processing — UUID 正则 + 异步 `getNote(id)` 取标题 +
  LRU 100 条缓存 + 左键跳转 / 右键复制 id + 失败回退到灰色 id
- 升级到方案 B (daemon structured `referenced_note_ids`) 触发条件: 误触率 > ~10%
  或用户反馈标题 stale

Original scoping notes below, kept for reference:

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

**Status (2026-05-03)**: ✅ shipped in P3.2-d (`owl open <id>` + `/events`
SSE channel, commits `5168b60`..`c565955`).

### Remote daemon connection

Old P2-1 scope. Dropped because it's tightly coupled with migration sync
semantics. **Moved to P4** (with the migration CLI rewrite).

### Semantic search / embeddings

From P2-7 design decisions. Current AI agent uses FTS5 trigram + LLM
query expansion (two-layer search). Embedding would add: `note_chunks`
table, async indexing queue, top-k cosine similarity. Designed as optional
layer that degrades to FTS when unavailable. **Moved to P4** — evaluated
alongside migration; FTS quality 够用则不做.

## Special notes

### Visual distinction

**Status (2026-05-04)**: P3.4-b concrete scope:

- `#随记` NoteList / 浏览页列表项左侧 4px **蓝色** 边框
- `#待办` 同上 **粉色** 边框
- 编辑器 tab 保持不变（避免脏标 / 激活态叠加噪音）
- **不加**侧栏快捷按钮（用户明确）
- 颜色 token: `--owl-pin-memo: #3b82f6` / `--owl-pin-todo: #ec4899`

**Pin / 置顶功能**: 独立合并到 P3.4-a (笔记排序模型) 里，所有笔记都可置顶，
不局限特殊笔记。特殊笔记边框是视觉 affordance，与 pin 状态正交。

Original scoping notes below, kept for reference:

**Context**: `#随记` (id `…0001`) and `#待办` (id `…0002`) are system-managed
notes that `ensureSpecialNotes` auto-creates / auto-restores. They currently
appear in the note list mixed with regular notes — no visual cue.

**P3 design** (superseded by P3.4-b above):

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

**Status (2026-05-04)**: moved to P6 (non-core polish). Three options below
kept for reference when P6 opens.

`append_memo` hardcodes the special memo id. If the user has their own
`#memo`-tagged note, there's a semantic mismatch. P6 options:

1. Keep `append_memo` targeting the special note, but advertise this clearly
   (tool description + UI hint when the user creates a `#memo` tag).
2. Change the tool to search for `#memo` tagged notes and write to the most
   recently updated one; fall back to the special note if none exist. More
   flexible, more surprise potential.
3. Split: `append_memo` → special note, `append_to_tagged` → user-chosen tag.

## Chat persistence details deferred to P3

**Status (2026-05-04)**: main chat persistence = P3.4-f (按
`2026-04-18-chat-persistence.md` plan). Items below remain **not in P3.4-f**
scope — move to P6 if they become priorities.

The `2026-04-18-chat-persistence.md` plan lists explicit out-of-scope items;
most of them belong here if they become priorities:

- Last-message preview under each sidebar entry.
- Unread indicators.
- Full-text search inside messages.
- Export conversations (Markdown / JSON).
- Per-conversation folder tagging (organize history).
- DraftReadyCard / note_applied event replay on history load.

## AI draft UX alternative — banner instead of stage-overwrite

**Status (2026-05-04)**: moved to P6. Current overwrite + pre_stage rollback
scheme 没明确 UX 投诉驱动，保持不变.

Discussed during P2-8 step 9. Current behavior: clicking "打开" on a
DraftReadyCard immediately overwrites the tab's content with the AI
version (and captures the user's pre-stage content for conflict rollback).

**Alternative (option C from the discussion)**: `stageAiUpdate` stashes
the pending payload without overwriting tab.content; the editor shows
a top banner "AI 提议了修改 [查看差异]" that opens ConflictDialog.
Cleaner and closer to Claude web, but requires a banner component and
conditional rendering in EditorPanel.

Deferred until we have a concrete UX complaint driving it.
