import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  createConsoleLogger,
  createDatabase,
  createNote,
  deleteNote,
  ensureDeviceId,
  ensureSpecialNotes,
} from '@owl/core';
import { DEFAULT_CONFIG, type OwlDatabase } from '@owl/core';
import type Database from 'better-sqlite3';
import { ConversationStore } from '../ai/conversations.js';
import { PreviewStore } from '../ai/preview-store.js';
import { createBuiltinRegistry } from '../ai/tools/index.js';
import { EventsBus } from '../events/bus.js';
import { ReminderScheduler } from '../scheduler.js';
import { buildServer } from '../server.js';

/** Parse SSE `event:` / `data:` blocks out of a raw buffer. */
interface SseEvent {
  event: string;
  data: unknown;
}
function parseSseEvents(raw: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of raw.split(/\n\n/)) {
    let evt = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) evt = line.slice(6).trimStart();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!evt) continue;
    const raw = dataLines.join('\n');
    try {
      out.push({ event: evt, data: raw ? JSON.parse(raw) : null });
    } catch {
      out.push({ event: evt, data: raw });
    }
  }
  return out;
}

/**
 * Pump the reader until `collected` contains an event matching `predicate`.
 * Appends every parsed event into `collected` so the caller can inspect
 * the full stream afterwards. Times out at `deadline` (ms since epoch).
 */
async function readUntilEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  collected: SseEvent[],
  buf: { value: string },
  predicate: (e: SseEvent) => boolean,
  deadline: number,
): Promise<void> {
  const decoder = new TextDecoder();
  while (Date.now() < deadline && !collected.some(predicate)) {
    const { value, done } = await reader.read();
    if (done) return;
    buf.value += decoder.decode(value, { stream: true });
    let sep = buf.value.indexOf('\n\n');
    while (sep !== -1) {
      collected.push(...parseSseEvents(buf.value.slice(0, sep + 2)));
      buf.value = buf.value.slice(sep + 2);
      sep = buf.value.indexOf('\n\n');
    }
  }
}

describe('events routes', () => {
  let app: ReturnType<typeof buildServer>;
  let db: OwlDatabase;
  let sqlite: Database.Database;
  let scheduler: ReminderScheduler;
  let eventsBus: EventsBus;
  let existingNoteId: string;
  let trashedNoteId: string;

  before(async () => {
    const result = createDatabase({ dbPath: ':memory:' });
    db = result.db;
    sqlite = result.sqlite;
    ensureSpecialNotes(db);
    const deviceId = ensureDeviceId(db);

    const logger = createConsoleLogger('events-test', 'silent');
    const config = structuredClone(DEFAULT_CONFIG);
    scheduler = new ReminderScheduler(db, sqlite, config, logger);
    eventsBus = new EventsBus();

    app = buildServer({
      db,
      sqlite,
      config,
      logger,
      deviceId,
      scheduler,
      toolRegistry: createBuiltinRegistry(),
      conversationStore: new ConversationStore(),
      previewStore: new PreviewStore(),
      eventsBus,
    });
    await app.ready();

    existingNoteId = createNote(db, sqlite, {
      content: 'hello events',
      folderId: null,
      tags: [],
      deviceId,
    }).id;
    const toTrash = createNote(db, sqlite, {
      content: 'trashed note',
      folderId: null,
      tags: [],
      deviceId,
    });
    deleteNote(db, sqlite, toTrash.id, {});
    trashedNoteId = toTrash.id;
  });

  after(async () => {
    scheduler.stop();
    await app.close();
    sqlite.close();
  });

  // ── POST /events/emit — validation ──

  it('POST /events/emit rejects unknown event type', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events/emit',
      payload: { type: 'nope', note_id: existingNoteId },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error_code, 'BAD_REQUEST');
  });

  it('POST /events/emit rejects missing note_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events/emit',
      payload: { type: 'open_note' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error_code, 'BAD_REQUEST');
  });

  it('POST /events/emit returns 404 when the note does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events/emit',
      payload: { type: 'open_note', note_id: 'does-not-exist' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error_code, 'NOTE_NOT_FOUND');
  });

  it('POST /events/emit returns 404 when the note is in trash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events/emit',
      payload: { type: 'open_note', note_id: trashedNoteId },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error_code, 'NOTE_NOT_FOUND');
    assert.match(res.json().message, /trash/);
  });

  it('POST /events/emit with no subscribers reports subscribers: 0', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/events/emit',
      payload: { type: 'open_note', note_id: existingNoteId },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().success, true);
    assert.equal(res.json().data.subscribers, 0);
  });

  // ── GET /events + end-to-end ──
  // Uses real listen() + global fetch + AbortController because `GET /events`
  // is an infinite stream. `app.inject` would block — it works for /ai/chat
  // only because that stream ends with a `done` event.

  it('GET /events streams hello + open_note, shutdown unblocks in <1s', async () => {
    // Own bus so we don't collide with the outer `eventsBus`.
    const localBus = new EventsBus();
    const localApp = buildServer({
      db,
      sqlite,
      config: structuredClone(DEFAULT_CONFIG),
      logger: createConsoleLogger('events-live', 'silent'),
      deviceId: ensureDeviceId(db),
      scheduler,
      toolRegistry: createBuiltinRegistry(),
      conversationStore: new ConversationStore(),
      previewStore: new PreviewStore(),
      eventsBus: localBus,
    });
    await localApp.listen({ host: '127.0.0.1', port: 0 });
    const addr = localApp.server.address();
    assert.ok(addr && typeof addr === 'object');
    const port = (addr as { port: number }).port;

    const ac = new AbortController();
    const resp = await fetch(`http://127.0.0.1:${port}/events`, {
      signal: ac.signal,
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(resp.status, 200);
    if (!resp.body) throw new Error('expected streaming body');

    // Read until we've captured both a `hello` and an `open_note` event.
    const events: SseEvent[] = [];
    const reader = resp.body.getReader();
    const buf = { value: '' };
    const readDeadline = Date.now() + 2000;

    // Wait for the hello event first.
    await readUntilEvent(reader, events, buf, (e) => e.event === 'hello', readDeadline);
    assert.ok(
      events.some((e) => e.event === 'hello'),
      `expected hello event, got ${JSON.stringify(events)}`,
    );

    // Now emit and wait for open_note to hit the reader.
    const emitRes = await localApp.inject({
      method: 'POST',
      url: '/events/emit',
      payload: { type: 'open_note', note_id: existingNoteId },
    });
    assert.equal(emitRes.statusCode, 200);
    assert.equal(emitRes.json().data.subscribers, 1);

    await readUntilEvent(reader, events, buf, (e) => e.event === 'open_note', readDeadline);
    const openNote = events.find((e) => e.event === 'open_note');
    assert.ok(openNote, `expected open_note event, got ${JSON.stringify(events)}`);
    assert.deepEqual(openNote.data, { type: 'open_note', note_id: existingNoteId });

    // T12: shutdown must unblock despite the still-open SSE subscriber.
    // We do NOT call ac.abort() first — preClose is what needs to end the
    // stream. Budget: 1s.
    const closeStart = Date.now();
    try {
      reader.releaseLock();
    } catch {
      // releaseLock may throw if we're mid-read; harmless.
    }
    await localApp.close();
    const closeElapsed = Date.now() - closeStart;
    assert.ok(
      closeElapsed < 1000,
      `app.close() took ${closeElapsed}ms (> 1000ms); preClose not ending SSE streams?`,
    );

    // Cleanup the fetch so the test runner can exit.
    ac.abort();
  });

  it('subscribers drops to 0 after a client disconnects', async () => {
    const localBus = new EventsBus();
    const localApp = buildServer({
      db,
      sqlite,
      config: structuredClone(DEFAULT_CONFIG),
      logger: createConsoleLogger('events-disconnect', 'silent'),
      deviceId: ensureDeviceId(db),
      scheduler,
      toolRegistry: createBuiltinRegistry(),
      conversationStore: new ConversationStore(),
      previewStore: new PreviewStore(),
      eventsBus: localBus,
    });
    await localApp.listen({ host: '127.0.0.1', port: 0 });
    const port = (localApp.server.address() as { port: number }).port;

    const ac = new AbortController();
    const resp = await fetch(`http://127.0.0.1:${port}/events`, {
      signal: ac.signal,
      headers: { Accept: 'text/event-stream' },
    });
    assert.equal(resp.status, 200);
    if (!resp.body) throw new Error('expected streaming body');
    const reader = resp.body.getReader();

    // Wait until the subscribe callback has actually registered — the
    // GET handler subscribes synchronously before flushing `hello`, so
    // reading any bytes guarantees the subscription is live.
    await reader.read();

    // Abort the client and wait for the socket close listener to fire.
    ac.abort();
    try {
      await reader.cancel();
    } catch {
      // expected
    }
    // Give the socket 'close' handler a tick to run.
    const drainDeadline = Date.now() + 500;
    while (localBus.size() > 0 && Date.now() < drainDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(localBus.size(), 0, 'cleanup should unsubscribe on client disconnect');

    // Emit should now report zero subscribers.
    const emitRes = await localApp.inject({
      method: 'POST',
      url: '/events/emit',
      payload: { type: 'open_note', note_id: existingNoteId },
    });
    assert.equal(emitRes.statusCode, 200);
    assert.equal(emitRes.json().data.subscribers, 0);

    await localApp.close();
  });
});
