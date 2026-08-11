/**
 * P5-b Step 10b — dual-profile core-only e2e (design §8).
 *
 * Sequential D1-D10 user journey through two owl profiles (A + B) talking
 * to one in-process skybridge server. Verifies the production sync
 * semantics push/pull/apply/LWW/tags/folders/conversation/reminder against
 * the real @orpheus-aviary/skybridge-client wire — not the FakeSkybridgeClient that core's
 * own engine.test.ts uses.
 *
 * Scope cut from design §8.3:
 *  - D11 / D11b (SSE bridge real change-event triggering runManualSync) →
 *    manual checklist, would need two daemon instances. Single-process
 *    automation is too fragile for the value gained — see Step 10a
 *    `bridge-lifecycle.test.ts` for the wiring and `sse-bridge.test.ts`
 *    (FakeRealClient onChange/onOpen/onError) for the trigger logic.
 *  - D12 (reconnect backoff) → already covered by `sse-bridge.test.ts`
 *    `describe('createSseBridge — reconnect with backoff')`.
 *
 * Two layers of gating:
 *  1. Filename — `sync.dual.e2e.ts` (no `.test.`), so default
 *     `node --test 'dist/**\/*.test.js'` glob does NOT match.
 *  2. Runtime — `{ skip: !SKYBRIDGE_E2E }` on the top-level suite. Running
 *     `node --test 'dist/**\/*.e2e.js'` without the env still skips.
 *
 * Sequential, not isolated: D2 builds on D1's setup, D3 pushes what D2
 * created, etc. The user journey mirrors the P5-a §13 manual acceptance
 * (D1-D8) and adds D9-D10 for entity types P5-b first ships.
 *
 * @orpheus-aviary/skybridge-server is imported via a variable specifier so `tsc -b` on a
 * clean checkout (skybridge uninstalled) still types. The structural
 * `SkybridgeServerModule` shape duplicates only what we actually call.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  type OwlDatabase,
  type RunSyncResult,
  appendConversationMessages,
  createDatabase,
  createFolder,
  createNote,
  deleteFolder,
  ensureDeviceId,
  persistSkybridgeIds,
  reorderNotesInFolder,
  runSync,
  setNotePinned,
  updateNote,
} from '@owl/core';
import type Database from 'better-sqlite3';

import { type RealSkybridgeClient, type SkybridgeClientModule, adaptClient } from './session.js';

const gate = process.env.SKYBRIDGE_E2E === '1';

// ─── Structural skybridge/server surface ─────────────────────────────
//
// Never named in an `import` statement so `tsc -b` on a clean checkout
// stays green. Only the fields we actually touch are declared.

interface SkybridgeServerModule {
  defaultConfig(dir: string): {
    server: { host: string; port: number };
    storage: { dbPath: string; attachmentRoot: string };
    logging: { level: string; file: string | null };
    auth: { tokenByteLength: number };
  };
  openDb(opts: { path: string; requireMigrationsApplied: boolean }): { close(): void };
  applyMigrations(db: unknown): void;
  buildApp(opts: { config: unknown; logger: false }): Promise<{
    app: {
      listen(opts: { host: string; port: number }): Promise<void>;
      close(): Promise<void>;
      server: { address(): { port: number } | string | null };
    };
    db: unknown;
  }>;
  createUser(db: unknown, input: { email: string; password: string }): Promise<{ id: string }>;
}

interface E2EServer {
  baseUrl: string;
  /** Handle on the server's own sqlite — exposed so `createUser` can seed
   *  test accounts in the same db the running fastify routes read from. */
  serverDb: unknown;
  module: SkybridgeServerModule;
  cleanup: () => Promise<void>;
}

async function startSkybridgeServer(): Promise<E2EServer> {
  const spec: string = '@orpheus-aviary/skybridge-server';
  const sb = (await import(spec)) as SkybridgeServerModule;

  const tmp = mkdtempSync(join(tmpdir(), 'sync-dual-e2e-'));
  const config = sb.defaultConfig(tmp);
  config.logging.file = null;
  config.logging.level = 'error';

  // Migrate a fresh skybridge db before buildApp opens it for routing.
  const initDb = sb.openDb({
    path: config.storage.dbPath,
    requireMigrationsApplied: false,
  });
  sb.applyMigrations(initDb);
  initDb.close();

  const built = await sb.buildApp({ config, logger: false });
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = built.app.server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no port from skybridge listen');

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    serverDb: built.db,
    module: sb,
    cleanup: async () => {
      await built.app.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

// ─── Profile factory ─────────────────────────────────────────────────

interface Profile {
  /** Friendly label for assertions (`A` / `B`). */
  label: string;
  db: OwlDatabase;
  sqlite: Database.Database;
  realClient: RealSkybridgeClient;
  workspaceId: string;
  /** Skybridge `[device].id` returned by registerDevice. */
  skybridgeDeviceId: string;
  /** Local owl uuid stored in `local_metadata.device_uuid`. */
  localUuid: string;
  serverUrl: string;
  cleanup: () => void;
}

const APP_VERSION = 'owl 0.5.0';

/**
 * Build a fully bootstrapped profile against the given skybridge server.
 *
 * Mirrors the production flow that GUI main's `sync-auth.ts` (Phase 7)
 * runs on login — remote login + registerDevice + ensureWorkspace —
 * but in memory only, since the test cares about sqlite state + client
 * surface, not on-disk toml. After Phase 10 retired daemon's lazy
 * bootstrap, daemon-side this identity is injected via
 * `installSkybridgeSession`; here we wire the realClient directly into
 * `ctx.skybridgeSession` because the e2e drives `runSync` without a
 * Fastify HTTP layer.
 */
async function createProfile(
  label: string,
  server: E2EServer,
  email: string,
  password: string,
): Promise<Profile> {
  // Variable specifier so `tsc -b` on a clean checkout (skybridge
  // uninstalled) still types — we lean on the structural
  // `SkybridgeClientModule` from session.ts instead of `typeof import(...)`.
  const spec: string = '@orpheus-aviary/skybridge-client';
  const sb = (await import(spec)) as SkybridgeClientModule;

  // 1. login
  const auth = await sb.login(server.baseUrl, email, password);

  // 2. open owl :memory: db + bootstrap local uuid
  const { db, sqlite } = createDatabase({ dbPath: ':memory:' });
  ensureDeviceId(db);
  const localUuid = (
    sqlite.prepare("SELECT value FROM local_metadata WHERE key = 'device_uuid'").get() as {
      value: string;
    }
  ).value;

  // 3. registerDevice (first client has no deviceId)
  let realClient = sb.createSkybridgeClient({
    authContext: auth,
  }) as unknown as RealSkybridgeClient;
  const device = await realClient.registerDevice({
    name: `e2e-${label}`,
    appVersion: APP_VERSION,
    clientVersion: sb.CLIENT_VERSION,
  });

  // 4. rebuild client with deviceId so subsequent calls carry it
  realClient = sb.createSkybridgeClient({
    authContext: auth,
    deviceId: device.id,
  }) as unknown as RealSkybridgeClient;

  // 5. ensure shared owl/default workspace (both profiles call this — same
  //    user, so they end up on the same workspaceId)
  const ws = await realClient.ensureWorkspace('owl', 'default');

  // 6. persist skybridge ids into local_metadata + non-destructive backfill
  //    (mirrors the production ensureSession sticky-write).
  persistSkybridgeIds(sqlite, device.id, ws.id);

  return {
    label,
    db,
    sqlite,
    realClient,
    workspaceId: ws.id,
    skybridgeDeviceId: device.id,
    localUuid,
    serverUrl: server.baseUrl,
    cleanup: () => sqlite.close(),
  };
}

// ─── runSync helper ──────────────────────────────────────────────────

function silentLogger() {
  return {
    info: () => {},
    warn: () => {},
    debug: () => {},
  };
}

async function runSyncOn(profile: Profile): Promise<RunSyncResult> {
  return runSync({
    db: profile.db,
    sqlite: profile.sqlite,
    client: adaptClient(profile.realClient),
    workspaceId: profile.workspaceId,
    serverUrl: profile.serverUrl,
    logger: silentLogger(),
  });
}

// ─── sqlite probe helpers ────────────────────────────────────────────

interface NoteRow {
  id: string;
  content: string;
  folder_id: string | null;
  trash_level: number;
  local_device_uuid: string;
  device_id: string | null;
}

function selectNote(sqlite: Database.Database, id: string): NoteRow | undefined {
  return sqlite
    .prepare(
      'SELECT id, content, folder_id, trash_level, local_device_uuid, device_id FROM notes WHERE id = ?',
    )
    .get(id) as NoteRow | undefined;
}

interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
}

function selectFolder(sqlite: Database.Database, id: string): FolderRow | undefined {
  return sqlite.prepare('SELECT id, name, parent_id FROM folders WHERE id = ?').get(id) as
    | FolderRow
    | undefined;
}

function pendingChangeCount(sqlite: Database.Database): number {
  const row = sqlite
    .prepare('SELECT count(*) AS n FROM sync_changes WHERE synced_at IS NULL')
    .get() as { n: number };
  return row.n;
}

function totalChangeCount(sqlite: Database.Database): number {
  const row = sqlite.prepare('SELECT count(*) AS n FROM sync_changes').get() as { n: number };
  return row.n;
}

// ─── Suite ───────────────────────────────────────────────────────────

describe('dual-profile core-only e2e (P5-b §8.3 D1-D10 + P5-c D14)', { skip: !gate }, () => {
  let server: E2EServer;
  let profileA: Profile;
  let profileB: Profile;

  // IDs created in D2 and reused by later cases. Declared here so the
  // sequential flow can hand state from D2 → D3 → D5 → … without a
  // shared mutable bag.
  let folderId: string;
  let noteId: string;
  const conversationId = '11111111-1111-4111-8111-111111111111';

  before(async () => {
    server = await startSkybridgeServer();

    // Unique user per test run; the in-process skybridge db is recreated
    // each invocation so even a stale tmp dir from a crashed prior run
    // doesn't collide. Long-enough password to clear skybridge's bcrypt
    // minimum.
    const email = `e2e-${Date.now()}@test.local`;
    const password = 'longenoughpw';
    await server.module.createUser(server.serverDb, { email, password });

    profileA = await createProfile('A', server, email, password);
    profileB = await createProfile('B', server, email, password);
  });

  after(async () => {
    profileA?.cleanup();
    profileB?.cleanup();
    await server?.cleanup();
  });

  it('D1 — A is fully bootstrapped: device + workspace registered', () => {
    assert.ok(profileA.skybridgeDeviceId, 'A should have a skybridge device id');
    assert.ok(profileA.workspaceId, 'A should have a workspace id');
    assert.notEqual(
      profileA.skybridgeDeviceId,
      profileA.localUuid,
      'skybridge device id and local owl uuid live in separate namespaces',
    );
    const meta = profileA.sqlite
      .prepare("SELECT value FROM local_metadata WHERE key = 'skybridge_device_id'")
      .get() as { value: string } | undefined;
    assert.equal(meta?.value, profileA.skybridgeDeviceId, 'persistSkybridgeIds wrote sticky id');
  });

  it('D2 — A creates note + folder + conversation + tags → sync_changes emitted with unique cids', () => {
    const folder = createFolder(profileA.db, profileA.sqlite, { name: 'work' });
    folderId = folder.id;

    // Tags are explicit ParsedTag[] (production GUI parses the editor's
    // content, but here we pass them directly to avoid coupling the e2e to
    // the editor's content-scanning code).
    const note = createNote(profileA.db, profileA.sqlite, {
      content: '#work hello world',
      folderId,
      tags: [{ tagType: '#', tagValue: 'work' }],
    });
    noteId = note.id;

    appendConversationMessages(
      profileA.sqlite,
      conversationId,
      [
        {
          role: 'user',
          content: 'hi',
          tool_calls: null,
          tool_call_id: null,
          is_error: null,
          reasoning_content: null,
          reasoning_signature: null,
        },
      ],
      Date.now(),
    );

    // Expected sync_changes: folder/create + note/create + conversation/append = 3
    const total = totalChangeCount(profileA.sqlite);
    assert.equal(total, 3, '3 sync_changes rows (folder/create, note/create, conv/append)');
    const cids = profileA.sqlite.prepare('SELECT client_change_id FROM sync_changes').all() as {
      client_change_id: string;
    }[];
    assert.equal(new Set(cids.map((r) => r.client_change_id)).size, 3, 'all cids unique');
    assert.equal(pendingChangeCount(profileA.sqlite), 3, 'all 3 still pending push');

    // Local row carries A's local uuid. P5-c G4: `createNote` now reads
    // `local_metadata.skybridge_device_id` (set by `persistSkybridgeIds` at
    // session setup, see fixture above) and stamps `notes.device_id` with
    // A's skybridge id. apply path still fills `device_id` directly from
    // `ServerChange.deviceId` (raw SQL), so cross-device flips in D7 are
    // unaffected.
    const row = selectNote(profileA.sqlite, noteId);
    assert.equal(row?.local_device_uuid, profileA.localUuid);
    assert.equal(
      row?.device_id,
      profileA.skybridgeDeviceId,
      'local create stamps device_id from skybridge_device_id (P5-c G4)',
    );
  });

  it('D3 — A first sync pushes all 3 changes; server_seq monotonic', async () => {
    const result = await runSyncOn(profileA);
    assert.equal(result.pushedTotal, 3, 'pushedTotal=3 for folder + note + conv');
    assert.equal(result.duplicatesTotal, 0);
    assert.equal(pendingChangeCount(profileA.sqlite), 0, 'all rows now have synced_at');

    // Self-pull on the same round may or may not echo back depending on
    // skybridge protocol; what's invariant is pendingCount drops to 0 and
    // server_seq is non-zero / monotonic.
    assert.ok(result.serverSeqHigh >= 3, 'server seq advanced past our 3 pushes');
  });

  it('D4 — A self-replay round: pulled changes are own pushes, all skipped', async () => {
    const result = await runSyncOn(profileA);
    // Server-side echo back of A's own pushes should hit the cid-self-replay
    // guard (sync_changes carries the cid we already wrote).
    if (result.pulledTotal > 0) {
      assert.equal(result.appliedTotal, 0, 'self-replay applies nothing');
      assert.equal(result.skippedTotal, result.pulledTotal, 'every pulled change is skipped');
    }
    assert.equal(result.pushedTotal, 0, 'nothing new to push');
  });

  it('D5 — B first sync: A entities + tags + FTS all present on B', async () => {
    const result = await runSyncOn(profileB);
    assert.ok(result.pulledTotal >= 3, `B pulled >=3 changes (got ${result.pulledTotal})`);
    assert.ok(result.appliedTotal >= 3, `B applied >=3 changes (got ${result.appliedTotal})`);

    const noteRowOnB = selectNote(profileB.sqlite, noteId);
    assert.ok(noteRowOnB, 'B has A’s note row');
    assert.equal(noteRowOnB?.folder_id, folderId);
    // P5-b §3.4: local_device_uuid is THIS machine's uuid; device_id is the
    // source skybridge id (A's).
    assert.equal(noteRowOnB?.local_device_uuid, profileB.localUuid, 'local_device_uuid = B');
    assert.equal(noteRowOnB?.device_id, profileA.skybridgeDeviceId, 'device_id = A’s skybridge id');

    const folderRowOnB = selectFolder(profileB.sqlite, folderId);
    assert.equal(folderRowOnB?.name, 'work');

    // note_tags + tags JOIN landed via syncNoteTags in apply path.
    const tagRows = profileB.sqlite
      .prepare(
        `SELECT t.tag_type, t.tag_value FROM note_tags nt
         JOIN tags t ON t.id = nt.tag_id
         WHERE nt.note_id = ?`,
      )
      .all(noteId) as { tag_type: string; tag_value: string }[];
    const hashTag = tagRows.find((r) => r.tag_type === '#' && r.tag_value === 'work');
    assert.ok(hashTag, `B has #work hashtag (got ${JSON.stringify(tagRows)})`);

    // FTS tags_text populated. notes_fts is external-content (content=notes),
    // so `SELECT tags_text FROM notes_fts` would trigger an alias-based
    // content-table lookup and fail (notes doesn't carry tags_text). Use
    // MATCH against the FTS5 index — that's both what production search
    // does and the only path that hits FTS5's own storage.
    const noteRowid = profileB.sqlite.prepare('SELECT rowid FROM notes WHERE id = ?').get(noteId) as
      | { rowid: number }
      | undefined;
    assert.ok(noteRowid, 'note has a rowid');
    const ftsHit = profileB.sqlite
      .prepare(`SELECT rowid FROM notes_fts WHERE tags_text MATCH 'work'`)
      .get() as { rowid: number } | undefined;
    assert.equal(ftsHit?.rowid, noteRowid?.rowid, 'FTS index finds hashtag on the note');

    // Conversation apply: B has the message
    const convMsgs = profileB.sqlite
      .prepare('SELECT content FROM ai_messages WHERE conversation_id = ?')
      .all(conversationId) as { content: string }[];
    assert.equal(convMsgs.length, 1);
    assert.equal(convMsgs[0]?.content, 'hi');
  });

  it('D6 — B edits A’s note and pushes', async () => {
    // updateNote needs the existing note as input. Fetch with content +
    // updated_at to feed back into the version-checked update.
    const existing = profileB.sqlite
      .prepare('SELECT id, content, updated_at FROM notes WHERE id = ?')
      .get(noteId) as { id: string; content: string; updated_at: number };
    updateNote(
      profileB.db,
      profileB.sqlite,
      existing.id,
      { content: `${existing.content}\n— edited by B` },
      { expectedUpdatedAt: existing.updated_at },
    );

    const result = await runSyncOn(profileB);
    assert.equal(result.pushedTotal, 1, 'B pushed exactly the one edit');
  });

  it('D7 — A pulls B’s edit; local_device_uuid stays A, device_id flips to B', async () => {
    const result = await runSyncOn(profileA);
    assert.ok(result.appliedTotal >= 1, 'A applied B’s edit');

    const row = selectNote(profileA.sqlite, noteId);
    assert.ok(row?.content.includes('— edited by B'), 'content updated to B’s version');
    assert.equal(row?.local_device_uuid, profileA.localUuid, 'local_device_uuid still A');
    assert.equal(row?.device_id, profileB.skybridgeDeviceId, 'device_id now points at B');
  });

  it('D8 — A deletes the folder; B sees folder gone + notes.folder_id=NULL via FK', async () => {
    deleteFolder(profileA.db, profileA.sqlite, folderId);
    await runSyncOn(profileA);
    await runSyncOn(profileB);

    assert.equal(selectFolder(profileB.sqlite, folderId), undefined, 'folder removed on B');
    const noteRow = selectNote(profileB.sqlite, noteId);
    assert.equal(
      noteRow?.folder_id,
      null,
      'FK ON DELETE SET NULL nulled out folder_id on B’s note',
    );
  });

  it('D9 — A + B each append to the same conversation; both end up with both messages in server order', async () => {
    appendConversationMessages(
      profileA.sqlite,
      conversationId,
      [
        {
          role: 'assistant',
          content: 'from A',
          tool_calls: null,
          tool_call_id: null,
          is_error: null,
          reasoning_content: null,
          reasoning_signature: null,
        },
      ],
      Date.now(),
    );
    appendConversationMessages(
      profileB.sqlite,
      conversationId,
      [
        {
          role: 'assistant',
          content: 'from B',
          tool_calls: null,
          tool_call_id: null,
          is_error: null,
          reasoning_content: null,
          reasoning_signature: null,
        },
      ],
      Date.now(),
    );

    // Cross-sync: each side pushes its own append, then pulls the other's.
    await runSyncOn(profileA);
    await runSyncOn(profileB);
    await runSyncOn(profileA);

    const aMsgs = profileA.sqlite
      .prepare('SELECT content FROM ai_messages WHERE conversation_id = ? ORDER BY seq ASC')
      .all(conversationId) as { content: string }[];
    const bMsgs = profileB.sqlite
      .prepare('SELECT content FROM ai_messages WHERE conversation_id = ? ORDER BY seq ASC')
      .all(conversationId) as { content: string }[];

    // Append-only merge (P5-b §4.3): no LWW, no dedup — both sides end up
    // with the union, ordered by server_seq.
    const aTexts = aMsgs.map((m) => m.content);
    const bTexts = bMsgs.map((m) => m.content);
    assert.ok(aTexts.includes('from A'), 'A retains its own append');
    assert.ok(aTexts.includes('from B'), 'A absorbed B’s append');
    assert.ok(bTexts.includes('from A'), 'B absorbed A’s append');
    assert.ok(bTexts.includes('from B'), 'B retains its own append');
  });

  it('D10 — A’s /alarm note ends up in B’s reminder_status with the same fire_at', async () => {
    // Use a folder-less note so D8’s cascade doesn’t interfere.
    const alarmNote = createNote(profileA.db, profileA.sqlite, {
      content: 'remind me',
      folderId: null,
      tags: [{ tagType: '/alarm', tagValue: '2030-06-01T09:00:00' }],
    });
    // P5-c G5: createNote now calls syncReminders synchronously when
    // input.tags includes /alarm. No explicit scheduler-tick simulation
    // needed — `alarmNote` already has its reminder_status row.
    await runSyncOn(profileA);
    await runSyncOn(profileB);

    const aFire = profileA.sqlite
      .prepare('SELECT fire_at, status FROM reminder_status WHERE note_id = ?')
      .get(alarmNote.id) as { fire_at: number; status: string } | undefined;
    const bFire = profileB.sqlite
      .prepare('SELECT fire_at, status FROM reminder_status WHERE note_id = ?')
      .get(alarmNote.id) as { fire_at: number; status: string } | undefined;

    assert.ok(aFire, 'A has a reminder_status row from createNote → syncReminders (P5-c G5)');
    // Apply path calls syncReminders for B automatically (engine.ts:247).
    assert.ok(bFire, 'B has a reminder_status row populated by apply');
    assert.equal(bFire?.fire_at, aFire?.fire_at, 'fire_at parsed identically on both sides');
    assert.equal(bFire?.status, 'pending', 'B’s reminder is queued for the scheduler');
  });

  it('D14 — concurrent edit → B pulls A’s newer update, conflict_record row written on B (P5-c §6.16)', async () => {
    // Snapshot pre-existing conflict counts (D7 already produced one on A
    // when A pulled B’s edit while A-local was older). D14 asserts the
    // *delta* attributable to this scenario, not absolute totals.
    const countRows = (sqlite: Database.Database): number =>
      (sqlite.prepare('SELECT count(*) AS n FROM conflict_record').get() as { n: number }).n;
    const aConflictsBefore = countRows(profileA.sqlite);
    const bConflictsBefore = countRows(profileB.sqlite);

    // 1. A creates a fresh note + syncs so B can pull baseline state.
    const seedNoteRow = createNote(profileA.db, profileA.sqlite, {
      content: 'v0 — baseline',
      folderId: null,
      tags: [],
    });
    const d14NoteId = seedNoteRow.id;
    await runSyncOn(profileA);
    await runSyncOn(profileB);

    const bBaseline = profileB.sqlite
      .prepare('SELECT content, updated_at FROM notes WHERE id = ?')
      .get(d14NoteId) as { content: string; updated_at: number };
    assert.ok(bBaseline, 'B pulled baseline note');
    assert.equal(bBaseline.content, 'v0 — baseline');

    // 2. B edits FIRST (so B-local has the OLDER updated_at_ms).
    updateNote(
      profileB.db,
      profileB.sqlite,
      d14NoteId,
      { content: 'B’s concurrent edit' },
      { expectedUpdatedAt: bBaseline.updated_at },
    );
    const bLocalAfterEdit = profileB.sqlite
      .prepare('SELECT content, updated_at FROM notes WHERE id = ?')
      .get(d14NoteId) as { content: string; updated_at: number };
    assert.equal(bLocalAfterEdit.content, 'B’s concurrent edit');

    // 3. Ensure A's edit lands at a strictly later wall-clock ms. Date.now()
    //    has ms granularity on macOS; sleep 5ms to be safe.
    await new Promise((r) => setTimeout(r, 5));

    // 4. A edits SECOND on its own copy (still on baseline content since A
    //    hasn't pulled B's pending edit).
    const aBaseline = profileA.sqlite
      .prepare('SELECT content, updated_at FROM notes WHERE id = ?')
      .get(d14NoteId) as { content: string; updated_at: number };
    updateNote(
      profileA.db,
      profileA.sqlite,
      d14NoteId,
      { content: 'A’s concurrent edit (wins LWW)' },
      { expectedUpdatedAt: aBaseline.updated_at },
    );
    const aLocalAfterEdit = profileA.sqlite
      .prepare('SELECT updated_at FROM notes WHERE id = ?')
      .get(d14NoteId) as { updated_at: number };
    assert.ok(
      aLocalAfterEdit.updated_at > bLocalAfterEdit.updated_at,
      `A’s updated_at (${aLocalAfterEdit.updated_at}) must be > B’s (${bLocalAfterEdit.updated_at})`,
    );

    // 5. A pushes its edit to the server.
    const aSync = await runSyncOn(profileA);
    assert.equal(aSync.pushedTotal, 1, 'A pushed its concurrent edit');
    assert.equal(aSync.conflictsRecorded, 0, 'A’s sync writes no conflict (A is the winner)');

    // 6. B syncs — pull A's edit (B-local is older → LWW loser → conflict),
    //    then push B's pending outbox row (accepted server-side, see §6.29).
    const bSync = await runSyncOn(profileB);
    assert.ok(bSync.appliedTotal >= 1, 'B applied A’s remote edit');
    assert.equal(bSync.conflictsRecorded, 1, 'B detected exactly 1 conflict on note update');
    assert.ok(bSync.pushedTotal >= 1, 'B still pushed its losing local edit (§6.29)');

    // 7. B's local content is now A's version (LWW apply).
    const bAfter = profileB.sqlite
      .prepare('SELECT content FROM notes WHERE id = ?')
      .get(d14NoteId) as { content: string };
    assert.equal(bAfter.content, 'A’s concurrent edit (wins LWW)');

    // 8. conflict_record row carries the losing local snapshot + winning
    //    remote payload + paired updated_at_ms. Scope query by entity_id
    //    so D7’s pre-existing conflict on a different note doesn’t leak in.
    const conflicts = profileB.sqlite
      .prepare(
        `SELECT entity_type, entity_id, losing_side, local_payload, remote_payload,
                local_updated_at_ms, remote_updated_at_ms, resolved_at,
                local_lww_counter, remote_lww_counter,
                local_device_id, remote_device_id
           FROM conflict_record WHERE entity_id = ?`,
      )
      .all(d14NoteId) as Array<{
      entity_type: string;
      entity_id: string;
      losing_side: string;
      local_payload: string;
      remote_payload: string;
      local_updated_at_ms: number;
      remote_updated_at_ms: number;
      resolved_at: number | null;
      local_lww_counter: number | null;
      remote_lww_counter: number | null;
      local_device_id: string | null;
      remote_device_id: string | null;
    }>;
    assert.equal(conflicts.length, 1, 'exactly one conflict row for this note on B');
    const row = conflicts[0];
    assert.equal(row.entity_type, 'note');
    assert.equal(row.losing_side, 'local');
    assert.equal(row.resolved_at, null, 'fresh row is unresolved');
    assert.equal(row.local_updated_at_ms, bLocalAfterEdit.updated_at);
    assert.equal(row.remote_updated_at_ms, aLocalAfterEdit.updated_at);
    // 0011 (W1): the full LWW three-tuple is persisted, not just the ms pair.
    assert.equal(typeof row.local_lww_counter, 'number', 'local counter recorded');
    assert.equal(typeof row.remote_lww_counter, 'number', 'remote counter recorded');
    assert.ok(row.local_device_id, 'local device_id recorded');
    assert.ok(row.remote_device_id, 'remote device_id recorded');
    assert.notEqual(row.local_device_id, row.remote_device_id, 'two distinct devices');

    const localPayload = JSON.parse(row.local_payload) as {
      content: string;
      updated_at_ms: number;
    };
    const remotePayload = JSON.parse(row.remote_payload) as {
      content: string;
      updated_at_ms: number;
    };
    assert.equal(
      localPayload.content,
      'B’s concurrent edit',
      'local_payload preserves losing copy',
    );
    assert.equal(
      remotePayload.content,
      'A’s concurrent edit (wins LWW)',
      'remote_payload has A’s winning text',
    );

    // 9. A side did not write any new conflict (A is the winner; only the
    //    losing side records). Asserted as a delta vs the pre-D14 snapshot
    //    so any D7-era conflict on A doesn’t cause a false positive.
    assert.equal(
      countRows(profileA.sqlite) - aConflictsBefore,
      0,
      'A’s conflict count did not grow during D14 (only the losing side records)',
    );
    assert.equal(
      countRows(profileB.sqlite) - bConflictsBefore,
      1,
      'B’s conflict count grew by exactly 1',
    );
  });

  // 0.6.3 V4 — pin / reorder used to be dropped on the receiving side, so
  // neither ever crossed devices. They carry no `updated_at_ms` and are
  // applied in arrival order rather than by LWW.
  it('D15 — pin and reorder cross devices; last write to reach the server wins', async () => {
    const readMeta = (
      sqlite: Database.Database,
      id: string,
    ): { pinned_at: number | null; position: number | null; updated_at: number } =>
      sqlite.prepare('SELECT pinned_at, position, updated_at FROM notes WHERE id = ?').get(id) as {
        pinned_at: number | null;
        position: number | null;
        updated_at: number;
      };

    // Two notes in the root folder so a reorder has something to order.
    const first = createNote(profileA.db, profileA.sqlite, {
      content: 'D15 first',
      folderId: null,
      tags: [],
    });
    const second = createNote(profileA.db, profileA.sqlite, {
      content: 'D15 second',
      folderId: null,
      tags: [],
    });
    await runSyncOn(profileA);
    await runSyncOn(profileB);
    assert.ok(selectNote(profileB.sqlite, first.id), 'B pulled the baseline notes');

    const bBefore = readMeta(profileB.sqlite, first.id);

    // A pins one note and reverses the root ordering. `reorderNotesInFolder`
    // demands the complete live set for the folder, and earlier cases have
    // left their own notes unfiled — so derive it rather than assume.
    setNotePinned(profileA.db, profileA.sqlite, first.id, true);
    const unfiled = profileA.sqlite
      .prepare(
        'SELECT id FROM notes WHERE folder_id IS NULL AND trash_level = 0 ORDER BY position, created_at',
      )
      .all() as { id: string }[];
    assert.ok(
      unfiled.some((r) => r.id === first.id) && unfiled.some((r) => r.id === second.id),
      'both D15 notes are unfiled',
    );
    reorderNotesInFolder(profileA.db, profileA.sqlite, null, unfiled.map((r) => r.id).reverse());
    await runSyncOn(profileA);
    await runSyncOn(profileB);

    const aAfter = readMeta(profileA.sqlite, first.id);
    const bAfter = readMeta(profileB.sqlite, first.id);
    assert.ok(aAfter.pinned_at, 'A pinned locally');
    assert.equal(bAfter.pinned_at, aAfter.pinned_at, 'pin crossed to B');
    assert.equal(bAfter.position, aAfter.position, 'ordering crossed to B');
    assert.equal(
      bAfter.updated_at,
      bBefore.updated_at,
      'metadata must not masquerade as a content edit on B',
    );

    // B unpins. A pulls and follows — arrival order decides, and nothing
    // about the earlier pin makes A's copy "win".
    setNotePinned(profileB.db, profileB.sqlite, first.id, false);
    await runSyncOn(profileB);
    await runSyncOn(profileA);
    assert.equal(readMeta(profileA.sqlite, first.id).pinned_at, null, 'B’s unpin reached A');

    // A re-pins and syncs: the round pushes A's change and pulls its own echo
    // back on the next round. A must end where the server is, not stranded.
    setNotePinned(profileA.db, profileA.sqlite, first.id, true);
    await runSyncOn(profileA);
    await runSyncOn(profileA);
    await runSyncOn(profileB);
    const aFinal = readMeta(profileA.sqlite, first.id);
    assert.ok(aFinal.pinned_at, 'A kept its own pin across the echo round');
    assert.equal(
      readMeta(profileB.sqlite, first.id).pinned_at,
      aFinal.pinned_at,
      'both devices converge',
    );
  });
});
