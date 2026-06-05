import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { runAppend } from './commands/append.js';
import { runCreate } from './commands/create.js';
import { runDelete, runRestore } from './commands/delete.js';
import { runDoctor } from './commands/doctor.js';
import { runEdit } from './commands/edit.js';
import { runFoldersList, runTagsList } from './commands/folders.js';
import { runGet } from './commands/get.js';
import { runMigrate } from './commands/migrate.js';
import { runOpen } from './commands/open.js';
import { runSearch } from './commands/search.js';
import { runSkillExport } from './commands/skill.js';
import { runSyncConfigShow, runSyncLogin, runSyncRun, runSyncStatus } from './commands/sync.js';
import { runTag } from './commands/tag.js';
import { runTrashList } from './commands/trash.js';
import { resolveConfig } from './lib/config.js';
import { buildContext } from './lib/context.js';
import type { GlobalOptions } from './lib/context.js';
import { CliError, exitCodeFor } from './lib/errors.js';
import { EXIT_CODES } from './lib/exit-codes.js';
import { writeError } from './lib/output.js';

const streams = { stdout: process.stdout, stderr: process.stderr };

/** Read CLI version from the nearest package.json. Bundled `dist/` has a
 *  sibling package.json; in dev (`tsx src/index.ts`) the workspace
 *  package.json sits one level up. */
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, 'package.json'), join(here, '..', 'package.json')]) {
    try {
      const v = (JSON.parse(readFileSync(p, 'utf8')) as { version?: string }).version;
      if (v) return v;
    } catch {}
  }
  return '0.0.0-dev';
}
const VERSION = readVersion();

/** Wrap an action that needs a backend + context — builds it, runs, and closes. */
// biome-ignore lint/suspicious/noExplicitAny: commander's variadic action signature resists strict typing here
function withContext<TArgs extends any[]>(
  isWrite: boolean,
  run: (ctx: Awaited<ReturnType<typeof buildContext>>, ...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
  return async (...args: TArgs) => {
    const cmd = args[args.length - 1] as Command;
    const opts = cmd.optsWithGlobals() as GlobalOptions;
    // Merge global flags into the subcommand flags object so handlers see
    // both in one place (pretty, idOnly, ndjson, overwrite, etc. live on
    // the root program but are consumed by individual handlers).
    const flagsArg = args[args.length - 2];
    if (flagsArg && typeof flagsArg === 'object') {
      Object.assign(flagsArg, {
        pretty: opts.pretty,
        ndjson: opts.ndjson,
        idOnly: opts.idOnly,
        overwrite: opts.overwrite,
      });
    }
    const ctx = await buildContext({ opts, isWrite });
    try {
      await run(ctx, ...args);
    } finally {
      await ctx.backend.close();
    }
  };
}

function parseIntOrThrow(label: string, value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    throw new CliError('USAGE_ERROR', `--${label} expects an integer`, { value });
  }
  return n;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function buildProgram(): Command {
  const program = new Command('owl');
  program.version(VERSION).description('Owl CLI — notes read/write for agents and humans');

  // ── Global flags ──
  program
    .option('--json', 'structured JSON output (default)')
    .option('--pretty', 'pretty-print JSON with 2-space indent')
    .option('--human', 'human-readable output (visual only, not stable)')
    .option('--ndjson', 'one JSON object per line for list/search results')
    .option('--id-only', 'print only ids (one per line) for list/search/trash')
    .option('--no-progress', 'suppress stderr progress lines')
    .option(
      '--direct',
      'force direct sqlite mode (reads always; writes need --force when daemon alive)',
    )
    .option('--force', 'allow --direct write while daemon is running (dangerous)')
    .option('--overwrite', 'skip CAS concurrency check on writes')
    .option('--config <path>', 'override owl_config.toml path')
    .option(
      '--db <path>',
      'override sqlite db path (escape hatch, triggers direct mode; default resolves the active profile db)',
    );

  // ── search [query] ──
  program
    .command('search [query]')
    .description('search notes (empty query → list recent)')
    .option('--limit <n>', 'max items per page (default 20)', (v) => parseIntOrThrow('limit', v))
    .option('--page <n>', 'page number (default 1)', (v) => parseIntOrThrow('page', v))
    .option('--folder <id>', 'filter by folder id')
    .option('--unfiled', 'filter to notes with no folder')
    .option('--tag <value>', 'filter by tag (repeatable)', collect, [])
    .option('--no-include-descendants', 'when --folder is set, exclude descendant folders')
    .option('--sort-by <field>', 'updated|created')
    .option('--sort-order <dir>', 'asc|desc')
    .action(
      withContext(false, async (ctx, query: string | undefined, flags: Record<string, unknown>) => {
        await runSearch(query, flags, { backend: ctx.backend, streams: ctx.streams });
      }),
    );

  // ── get <id> ──
  program
    .command('get <id>')
    .description('fetch a full note by id')
    .option('--field <name>', 'emit only this field (content/title/tags/…)')
    .option('--raw', 'emit the content field as plain text')
    .action(
      withContext(false, async (ctx, id: string, flags: Record<string, unknown>) => {
        await runGet(id, flags, { backend: ctx.backend, streams: ctx.streams });
      }),
    );

  // ── create ──
  program
    .command('create')
    .description('create a new note')
    .option('--body <text>', 'content string')
    .option('--file <path>', 'read content from file')
    .option('--stdin', 'read content from stdin')
    .option('--data <json>', 'full JSON object {content, folder_id?, tags?}')
    .option('--data-file <path>', 'read JSON object from file')
    .option('--tags <csv>', 'comma-separated tags')
    .option('--tag <value>', 'single tag (repeatable)', collect, [])
    .option('--folder <id>', 'place in folder')
    .option('--unfiled', 'place with no folder')
    .action(
      withContext(true, async (ctx, flags: Record<string, unknown>) => {
        await runCreate(flags, { backend: ctx.backend, streams: ctx.streams });
      }),
    );

  // ── edit <id> ──
  program
    .command('edit <id>')
    .description('update a note (PATCH by default, --replace for PUT, --interactive for $EDITOR)')
    .option('--body <text>', 'new content')
    .option('--file <path>', 'new content from file')
    .option('--stdin', 'new content from stdin')
    .option('--data <json>', 'full JSON payload')
    .option('--data-file <path>', 'JSON payload from file')
    .option('--tags <csv>', 'replace tags with CSV list')
    .option('--tag <value>', 'replace tags with repeated flag', collect, [])
    .option('--folder <id>', 'move to folder')
    .option('--unfiled', 'clear folder')
    .option('--replace', 'PUT strict replace — requires content + tags + folder')
    .option('--interactive', 'open $EDITOR to edit content')
    .option('--if-updated-at <ms>', 'CAS baseline (ms)', (v) => parseIntOrThrow('if-updated-at', v))
    .action(
      withContext(true, async (ctx, id: string, flags: Record<string, unknown>) => {
        await runEdit(id, flags, { backend: ctx.backend, streams: ctx.streams });
      }),
    );

  // ── append <id> ──
  program
    .command('append <id>')
    .description('append text to a note (CAS by default)')
    .option('--body <text>', 'text to append')
    .option('--stdin', 'append from stdin')
    .option(
      '--separator <str>',
      'separator between existing content and appended text (default \\n\\n)',
    )
    .option('--no-newline', 'concatenate without inserting a separator')
    .option('--if-updated-at <ms>', 'CAS baseline (ms)', (v) => parseIntOrThrow('if-updated-at', v))
    .action(
      withContext(true, async (ctx, id: string, flags: Record<string, unknown>) => {
        await runAppend(id, flags, { backend: ctx.backend, streams: ctx.streams });
      }),
    );

  // ── tag <id> ──
  program
    .command('tag <id>')
    .description('add or remove tags on a note (CAS by default)')
    .option('--add <value>', 'tag to add (repeatable)', collect, [])
    .option('--remove <value>', 'tag to remove (repeatable)', collect, [])
    .option('--if-updated-at <ms>', 'CAS baseline (ms)', (v) => parseIntOrThrow('if-updated-at', v))
    .action(
      withContext(true, async (ctx, id: string, flags: Record<string, unknown>) => {
        await runTag(id, flags, { backend: ctx.backend, streams: ctx.streams });
      }),
    );

  // ── delete <id> ──
  program
    .command('delete <id>')
    .description('soft-delete (move to trash level 1)')
    .option('--if-updated-at <ms>', 'CAS baseline (ms)', (v) => parseIntOrThrow('if-updated-at', v))
    .action(
      withContext(true, async (ctx, id: string, flags: Record<string, unknown>) => {
        await runDelete(id, flags, { backend: ctx.backend, streams: ctx.streams });
      }),
    );

  // ── restore <id> ──
  program
    .command('restore <id>')
    .description('restore a trashed note back to level 0')
    .option('--if-updated-at <ms>', 'CAS baseline (ms)', (v) => parseIntOrThrow('if-updated-at', v))
    .action(
      withContext(true, async (ctx, id: string, flags: Record<string, unknown>) => {
        await runRestore(id, flags, { backend: ctx.backend, streams: ctx.streams });
      }),
    );

  // ── trash list ──
  const trash = program.command('trash').description('trash operations');
  trash
    .command('list')
    .description('list trashed notes')
    .option(
      '--level <n>',
      'trash level 1 or 2 (default 1)',
      (v) => parseIntOrThrow('level', v) as 1 | 2,
    )
    .option('--limit <n>', 'max items per page', (v) => parseIntOrThrow('limit', v))
    .option('--page <n>', 'page number', (v) => parseIntOrThrow('page', v))
    .action(
      withContext(false, async (ctx, flags: Record<string, unknown>) => {
        await runTrashList(flags, { backend: ctx.backend, streams: ctx.streams });
      }),
    );

  // ── folders list ──
  const folders = program.command('folders').description('folder operations');
  folders
    .command('list')
    .description('list folders')
    .action(
      withContext(false, async (ctx, flags: Record<string, unknown>) => {
        await runFoldersList(flags, { backend: ctx.backend, streams: ctx.streams });
      }),
    );

  // ── tags list ──
  const tags = program.command('tags').description('tag operations');
  tags
    .command('list')
    .description('list hashtag tags')
    .option('--frequent', 'sort by usage count and include counts')
    .option('--limit <n>', 'max rows', (v) => parseIntOrThrow('limit', v))
    .option('--value-only', 'print only tag values, one per line')
    .action(
      withContext(false, async (ctx, flags: Record<string, unknown>) => {
        await runTagsList(flags, { backend: ctx.backend, streams: ctx.streams });
      }),
    );

  // ── doctor ──
  program
    .command('doctor')
    .description('inspect env / config / daemon / db')
    .option('--llm', 'include LLM check')
    .option('--all', 'include all optional checks')
    .action(async (flags: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const config = resolveConfig({
        ...(opts.config !== undefined ? { configPath: opts.config } : {}),
        ...(opts.db !== undefined ? { dbPath: opts.db } : {}),
      });
      const report = await runDoctor({ ...flags, pretty: opts.pretty }, { config, streams });
      if (report.status === 'fail') process.exit(EXIT_CODES.ENV);
    });

  // ── open ──
  program
    .command('open')
    .description('focus the GUI editor on a note by id (ignores --direct/--db; HTTP only)')
    .argument('<id>', 'note id')
    .action(async (id: string, _flags: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      // Do NOT forward opts.db — `open` is a GUI-only action that reads
      // only daemon.port from config. Global --direct / --db are accepted
      // at the root parser but ignored here.
      const config = resolveConfig(opts.config !== undefined ? { configPath: opts.config } : {});
      await runOpen(id, { pretty: opts.pretty ?? false }, { config, streams });
    });

  // ── migrate ──
  program
    .command('migrate')
    .description('rebuild a v0 database into the current schema')
    .option('-y, --yes', 'skip the y/N prompt (required when stdin is not a TTY)')
    .action(async (flags: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      const config = resolveConfig({
        ...(opts.config !== undefined ? { configPath: opts.config } : {}),
        ...(opts.db !== undefined ? { dbPath: opts.db } : {}),
      });
      await runMigrate(
        {
          ...flags,
          pretty: opts.pretty,
          progress: opts.progress !== false,
        },
        {
          dbPath: config.dbPath,
          daemonPort: config.daemonPort,
          pidPath: config.pidPath,
          streams,
        },
      );
    });

  // ── sync (P5-a Step 8) ──
  // Daemon-only. No `withContext` because we don't need an OwlBackend —
  // each subcommand fetches the daemon directly.
  const syncCmd = program.command('sync').description('skybridge sync (P5-a manual)');
  syncCmd
    .command('run')
    .description('trigger one manual sync round (pull then push)')
    .action(async (_: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      await runSyncRun({ pretty: opts.pretty === true, direct: opts.direct === true }, { streams });
    });
  syncCmd
    .command('status')
    .description('show skybridge configuration + cursor + pending counts')
    .action(async (_: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      await runSyncStatus(
        { pretty: opts.pretty === true, direct: opts.direct === true },
        { streams },
      );
    });
  syncCmd
    .command('login')
    .description('(removed) login is GUI-only — log in via the owl GUI (Settings → Sync)')
    // `--email` / `--server-url` stay registered (and ignored) so old scripts
    // get the friendly redirect from runSyncLogin, not an "unknown option" error.
    .option('--email <email>', '(ignored) login email')
    .option('--server-url <url>', '(ignored) skybridge server URL')
    .action(async (flags: { email?: string; serverUrl?: string }, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      await runSyncLogin(
        {
          email: flags.email,
          serverUrl: flags.serverUrl,
          pretty: opts.pretty === true,
          direct: opts.direct === true,
        },
        { streams },
      );
    });
  const syncConfig = syncCmd.command('config').description('inspect local skybridge configuration');
  syncConfig
    .command('show')
    .description('print skybridge_config.toml with the auth token masked')
    .action(async (_: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      await runSyncConfigShow({ pretty: opts.pretty === true }, { streams });
    });

  // ── skill export ──
  // Intentional exception to CLI's JSON-first default: this command
  // defaults to human output because its value is the install prompt
  // the user copies to their agent. Pass --json for { path, prompt }.
  // See docs/plans/2026-05-03-p3-2-5-design.md §3.2.
  const skill = program.command('skill').description('skill file operations for AI agents');
  skill
    .command('export')
    .description('export owl CLI skill markdown (default: ~/orpheus-aviary-nest/owl/owl-skill.md)')
    .option('--output <path>', 'output path (file or directory)')
    .action(async (flags: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      await runSkillExport(
        {
          ...flags,
          pretty: opts.pretty === true,
          json: opts.json === true,
          human: opts.human === true,
        },
        { streams, version: VERSION },
      );
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CliError) {
      writeError(err, { streams });
      process.exit(exitCodeFor(err.code));
    }
    writeError(err instanceof Error ? err : new Error(String(err)), { streams });
    process.exit(EXIT_CODES.FAILURE);
  }
}

// Only auto-run when invoked as a script (not imported).
// `npm i -g` installs this file under node_modules/@orpheus-aviary/owl-cli/
// and links bin/owl → that path via symlink. Node keeps argv[1] as the
// symlink path, while import.meta.url is the realpath, so a string-equal
// shortcut + realpath fallback covers both direct and symlinked invocations.
// Wrap in try/catch for environments where argv[1] isn't a file.
const entryPath = process.argv[1];
if (entryPath) {
  try {
    const self = fileURLToPath(import.meta.url);
    if (entryPath === self || realpathSync(entryPath) === self) {
      await main();
    }
  } catch {
    // argv[1] doesn't resolve — not a script invocation, stay silent.
  }
}

export { main };
