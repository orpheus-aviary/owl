/**
 * Renders the Claude Code SKILL.md content for the owl CLI. Output is
 * consumed by `owl skill export`: user writes it to disk and pastes a
 * one-line prompt to their AI agent, which then installs it into the
 * host's skill directory.
 *
 * Contract (tested in skill.test.ts):
 * - Starts with valid YAML frontmatter (`---\nname: owl\n...\n---\n`)
 * - `name: owl` exactly
 * - `description:` length > 80 chars (triggers need context to match)
 * - Injected `version` appears in body
 * - Every currently-registered command name appears
 * - Exit code table covers all 7 values (0/1/2/3/4/5/130)
 * - MUST NOT contain `"success":` or the `{success, data, message}`
 *   envelope string — reality is each command prints its own JSON
 */
export interface SkillTemplateParams {
  version: string;
}

export function renderOwlSkillTemplate({ version }: SkillTemplateParams): string {
  return `---
name: owl
description: Use when the user wants to search, read, create, edit, append, tag, delete, or restore notes managed by owl (猫头鹰笔记 TypeScript rewrite). Trigger for phrases like "查笔记", "添加笔记", "追加到 memo", "#xxx 标签", "打开这条笔记" followed by a UUID, or explicit "用 owl" mentions. This skill wraps the \`owl\` CLI (commander-based, JSON-first output). Skip for non-owl note apps and pure shell tasks.
---

# owl — notes CLI for agents

owl (version ${version}) is the CLI for 猫头鹰笔记. When the owl GUI daemon is
running on 127.0.0.1:47010 it goes through HTTP and shares state with the
GUI in real time; when the daemon is not running it talks directly to the
local SQLite file (WAL mode). Both paths end up in the same \`owl.db\`.

## Invocation

Run via the Bash tool: \`owl <command> [flags]\`.

### Output shape

Each command prints its own business JSON directly to stdout. There is
**no** envelope wrapper. Parse the raw object:

- \`owl search\` → \`{ "total": N, "items": [...], "limit": N, "page": N }\`
- \`owl get <id>\` → note object: \`{ "id", "content", "tags", "folder_id", "created_at", "updated_at", ... }\`
- \`owl create\` / \`owl edit\` / \`owl append\` / \`owl tag\` → saved note object
- \`owl delete\` / \`owl restore\` → updated note object (trash level toggled)
- \`owl folders list\` / \`owl tags list\` → \`{ "items": [...] }\`
- \`owl trash list\` → \`{ "total", "items", "limit", "page" }\` (like search)
- \`owl doctor\` → \`{ "status": "ok"|"warn"|"fail", "checks": [...] }\`
- \`owl open <id>\` → \`{ "opened": "<id>", "subscribers": N }\`
- \`owl migrate\` → progress lines on stderr, final summary on stdout

### Error format

On failure the process exits non-zero and writes to **stderr**:

\`\`\`json
{ "error": { "code": "USAGE_ERROR|NOTE_NOT_FOUND|...", "message": "...", "details": { ... } } }
\`\`\`

Code is string-typed and stable enough to branch on.

### Common flags (note commands)

Note commands default to JSON on stdout. Useful flags:

- \`--pretty\` — 2-space indented JSON (for human reading only)
- \`--ndjson\` — one JSON object per line (useful for list/search when piping)
- \`--id-only\` — print only ids, one per line (cheap to pipe into xargs / another owl call)
- \`--direct\` — force direct SQLite mode even if the daemon is running
- \`--force\` — allow direct-mode writes while the daemon is up (dangerous)
- \`--overwrite\` — skip CAS version check on writes
- \`--config <path>\` / \`--db <path>\` — override resolution

The only command that defaults to human-readable output is
\`owl skill export\`, which writes a markdown file and prints a
copy-pasteable install prompt; pass \`--json\` to that command if you
want \`{ "path": "...", "prompt": "..." }\` instead.

## Commands

### owl search [query]

List or search notes. Empty query → recent notes by \`updated_at desc\`.
Flags: \`--limit N\`, \`--page N\`, \`--folder <id>\`, \`--unfiled\`,
\`--tag <value>\` (repeatable), \`--no-include-descendants\`,
\`--sort-by updated|created\`, \`--sort-order asc|desc\`.

\`\`\`bash
owl search --tag memo --limit 5 --pretty
owl search "项目 A" --id-only
\`\`\`

### owl get <id>

Fetch a full note. Flags: \`--field <name>\` (\`content\` / \`title\` / \`tags\` / …) to
emit only one field; \`--raw\` to print the content field as plain text.

\`\`\`bash
owl get 3f2a-... --field content --raw
\`\`\`

### owl create

Create a note. Content comes from \`--body <text>\`, \`--file <path>\`,
\`--stdin\`, \`--data <json>\`, or \`--data-file <path>\` (mutually exclusive).
Tags: \`--tags a,b,c\` or repeatable \`--tag\`. Folder: \`--folder <id>\` or \`--unfiled\`.

\`\`\`bash
echo "# 今日会议\\n..." | owl create --stdin --tag '#memo'
owl create --body "待办：写文档" --tag '#todo'
\`\`\`

### owl edit <id>

Update a note. Default is PATCH (partial); \`--replace\` switches to PUT
(strict; requires content + tags + folder together). \`--interactive\`
opens \`$EDITOR\`. CAS via \`--if-updated-at <ms>\`.

\`\`\`bash
owl edit 3f2a-... --body "..." --tags '#memo,#draft'
owl edit 3f2a-... --folder abc-folder
\`\`\`

### owl append <id>

Append text to an existing note. Default separator is two newlines;
override with \`--separator <str>\` or disable via \`--no-newline\`. CAS
via \`--if-updated-at <ms>\`.

\`\`\`bash
echo "新的一条" | owl append 3f2a-... --stdin
\`\`\`

### owl tag <id>

Add or remove tags. Repeatable \`--add <value>\` and \`--remove <value>\`.
CAS via \`--if-updated-at <ms>\`.

\`\`\`bash
owl tag 3f2a-... --add '#important' --remove '#draft'
\`\`\`

### owl delete <id>

Soft-delete (trash level 1). \`--if-updated-at <ms>\` for CAS.

### owl restore <id>

Restore a trashed note back to level 0.

### owl trash list

List trashed notes. \`--level 1|2\` (default 1), \`--limit\`, \`--page\`.

### owl folders list

List folders. Returns \`{ "items": [...] }\`.

### owl tags list

List hashtag tags. \`--frequent\` sorts by usage count and includes counts;
\`--limit N\`; \`--value-only\` to get bare tag values one per line.

### owl doctor

Inspect environment, config, daemon, and DB. Exits 3 on fail, 0 on ok or warn.

\`\`\`bash
owl doctor --pretty
\`\`\`

### owl open <id>

Focus the GUI editor on a note. Requires the daemon to be running and
the GUI to have an active SSE subscription. Exits non-zero if no GUI is
subscribed.

### owl migrate

Rebuild a v0 database into the current schema. Interactive y/N prompt
unless \`-y\` / \`--yes\` is passed (required for non-TTY stdin).

### owl skill export

Export this skill to a markdown file and print the install prompt.
\`--output <path>\` overrides the default location
(\`~/orpheus-aviary-nest/owl/owl-skill.md\`).

## Common patterns

- **Find notes by tag, pipe ids**: \`owl search --tag memo --id-only | head -5\`
- **Dump a note's raw content**: \`owl get <id> --field content --raw\`
- **Append without overwriting a busy tab**: \`owl append\` is CAS-safe; \`owl edit --replace\` is not
- **Pre-create from a plan file**: \`owl create --file plan.md --tag '#project'\`
- **Safer batch ops**: chain \`owl search --id-only\` → \`xargs -I{} owl tag {} --add '#archive'\`

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (includes \`owl doctor\` reporting \`warn\`) |
| 1 | Ordinary failure (\`NOTE_NOT_FOUND\`, \`DB_BUSY\`, \`HTTP_ERROR\`, \`UNKNOWN\`) |
| 2 | Usage / argument error (\`USAGE_ERROR\`, \`INVALID_JSON_INPUT\`, \`INVALID_TAG\`) |
| 3 | Environment / config problem (\`CONFIG_NOT_FOUND\`, \`owl doctor\` fail) |
| 4 | Daemon unavailable (HTTP mode required but daemon not running) |
| 5 | Conflict (\`VERSION_MISMATCH\`, \`DAEMON_RUNNING_BLOCKED\`, \`MIGRATION_BUSY\`, …) |
| 130 | Cancelled (SIGINT, \`owl migrate\` y/N answered N) |

## Notes for the agent

- Always use the Bash tool to run \`owl\`; do not try to import it as a module
- Parse stdout as JSON unless \`--raw\` / \`--id-only\` was passed
- On non-zero exit, read stderr for the \`{ "error": ... }\` envelope
- Note ids are UUIDs. The system has two special notes (\`#随记\` and \`#待办\`)
  with fixed ids ending in \`...0001\` and \`...0002\`; those are auto-created
  and auto-restored, so treat them as always-present
`;
}
