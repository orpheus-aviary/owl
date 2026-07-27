import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DEFAULT_CONFIG, createDatabase, ensureDeviceId } from '@owl/core';
import type Database from 'better-sqlite3';
import type { AppContext } from '../context.js';
import { EventsBus } from '../events/bus.js';
import type { OwlEvent, SyncStatusSnapshot } from '../events/types.js';
import { createSyncStatusBroadcaster, getSyncStatusBroadcaster } from './status-broadcaster.js';

function makeStubCtx(): { ctx: AppContext; sqlite: Database.Database; bus: EventsBus } {
  const { db, sqlite } = createDatabase({ dbPath: ':memory:' });
  ensureDeviceId(db);
  const bus = new EventsBus();
  const ctx = {
    db,
    sqlite,
    eventsBus: bus,
    config: structuredClone(DEFAULT_CONFIG),
  } as unknown as AppContext;
  return { ctx, sqlite, bus };
}

function captureEvents(bus: EventsBus): { events: OwlEvent[]; statuses: SyncStatusSnapshot[] } {
  const events: OwlEvent[] = [];
  const statuses: SyncStatusSnapshot[] = [];
  bus.subscribe((e) => {
    events.push(e);
    if (e.type === 'sync:status_changed') statuses.push(e.status);
  });
  return { events, statuses };
}

describe('SyncStatusBroadcaster — emits sync:status_changed on transitions', () => {
  let ctx: AppContext;
  let bus: EventsBus;

  beforeEach(() => {
    const made = makeStubCtx();
    ctx = made.ctx;
    bus = made.bus;
  });

  it('markSyncing → emits state=syncing', () => {
    const { statuses } = captureEvents(bus);
    const b = createSyncStatusBroadcaster(ctx);
    b.markSyncing();
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.state, 'syncing');
    assert.equal(statuses[0]?.last_error, null);
  });

  it('markSuccess → emits state=idle + bumps cursor + clears error', () => {
    const { statuses } = captureEvents(bus);
    const b = createSyncStatusBroadcaster(ctx);
    b.markSyncing();
    b.markSuccess({ pulled_seq: 12, pushed_seq: 7, last_sync_at: 9_000 });
    const last = statuses.at(-1);
    assert.ok(last, 'expected at least one status');
    assert.equal(last.state, 'idle');
    assert.equal(last.pulled_seq, 12);
    assert.equal(last.pushed_seq, 7);
    assert.equal(last.last_sync_at, 9_000);
    assert.equal(last.last_error, null);
  });

  it('markSuccess re-counts pending from sync_changes outbox', () => {
    const { ctx: ctx2, sqlite, bus: bus2 } = makeStubCtx();
    sqlite
      .prepare(
        "INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload, created_at, client_change_id, synced_at) VALUES ('d', 'note', 'n1', 'create', '{}', 0, 'cid1', NULL)",
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO sync_changes (device_id, entity_type, entity_id, op, payload, created_at, client_change_id, synced_at) VALUES ('d', 'note', 'n2', 'create', '{}', 0, 'cid2', 100)",
      )
      .run();
    const { statuses } = captureEvents(bus2);
    const b = createSyncStatusBroadcaster(ctx2);
    b.markSuccess({});
    assert.equal(statuses.at(-1)?.pending_count, 1, 'only un-synced rows counted');
  });

  it('markError → emits state=error with message', () => {
    const { statuses } = captureEvents(bus);
    const b = createSyncStatusBroadcaster(ctx);
    b.markError(new Error('boom'));
    assert.equal(statuses.at(-1)?.state, 'error');
    assert.equal(statuses.at(-1)?.last_error, 'boom');
  });

  it('markOffline → state=offline; markConnected flips back to idle', () => {
    const { statuses } = captureEvents(bus);
    const b = createSyncStatusBroadcaster(ctx);
    b.markOffline(new Error('net'));
    assert.equal(statuses.at(-1)?.state, 'offline');
    assert.equal(statuses.at(-1)?.last_error, 'net');
    b.markConnected();
    assert.equal(statuses.at(-1)?.state, 'idle');
    assert.equal(statuses.at(-1)?.last_error, null);
  });

  it('markConnected during syncing → no-op (manual sync owns idle transitions)', () => {
    const { statuses } = captureEvents(bus);
    const b = createSyncStatusBroadcaster(ctx);
    b.markSyncing();
    const before = statuses.length;
    b.markConnected();
    assert.equal(statuses.length, before, 'no emit when already syncing');
  });
});

describe('getSyncStatusBroadcaster — WeakMap caching', () => {
  let ctx: AppContext;
  let other: AppContext;
  before(() => {
    ctx = makeStubCtx().ctx;
    other = makeStubCtx().ctx;
  });
  after(() => {
    ctx.sqlite.close();
    other.sqlite.close();
  });

  it('returns same instance for same ctx', () => {
    const a = getSyncStatusBroadcaster(ctx);
    const b = getSyncStatusBroadcaster(ctx);
    assert.equal(a, b);
  });

  it('returns different instances for different ctxs', () => {
    const a = getSyncStatusBroadcaster(ctx);
    const b = getSyncStatusBroadcaster(other);
    assert.notEqual(a, b);
  });
});

// ─── 0.6.2 W3: auth_required ─────────────────────────────────────────

describe('SyncStatusBroadcaster — auth_required is sticky (0.6.2 W3)', () => {
  let ctx: AppContext;
  let bus: EventsBus;

  beforeEach(() => {
    const made = makeStubCtx();
    ctx = made.ctx;
    bus = made.bus;
  });

  it('markAuthRequired emits the state + reason', () => {
    const { statuses } = captureEvents(bus);
    const b = createSyncStatusBroadcaster(ctx);
    b.markAuthRequired('token_rejected', '401');
    assert.equal(statuses.at(-1)?.state, 'auth_required');
    assert.equal(statuses.at(-1)?.auth_reason, 'token_rejected');
    assert.equal(statuses.at(-1)?.last_error, '401');
  });

  it('the same reason twice emits once (dedupe lives in the broadcaster)', () => {
    const { statuses } = captureEvents(bus);
    const b = createSyncStatusBroadcaster(ctx);
    b.markAuthRequired('token_rejected', '401');
    const seen = statuses.length;
    b.markAuthRequired('token_rejected', '401 again');
    assert.equal(statuses.length, seen, 'no second emit for the same reason');
  });

  it('a weaker reason never overwrites a stronger one', () => {
    const b = createSyncStatusBroadcaster(ctx);
    b.markAuthRequired('token_rejected', 'rejected');
    b.markAuthRequired('missing_session', 'no session');
    assert.equal(b.snapshot().auth_reason, 'token_rejected');

    b.markAuthRequired('credentials_missing', 'gone');
    assert.equal(b.snapshot().auth_reason, 'credentials_missing', 'stronger wins');
    b.markAuthRequired('token_rejected', 'rejected');
    assert.equal(b.snapshot().auth_reason, 'credentials_missing');
  });

  it('markError / markOffline keep the state and only record the error', () => {
    const b = createSyncStatusBroadcaster(ctx);
    b.markAuthRequired('token_rejected', '401');

    b.markError(new Error('boom'));
    assert.equal(b.snapshot().state, 'auth_required');
    assert.equal(b.snapshot().auth_reason, 'token_rejected');
    assert.equal(b.snapshot().last_error, 'boom');

    b.markOffline(new Error('net'));
    assert.equal(b.snapshot().state, 'auth_required');
    assert.equal(b.snapshot().last_error, 'net');
  });

  it('markConnected does not clear it (an open stream says nothing about auth)', () => {
    const b = createSyncStatusBroadcaster(ctx);
    b.markAuthRequired('token_rejected', '401');
    b.markConnected();
    assert.equal(b.snapshot().state, 'auth_required');
  });

  it('markSyncing with no session is a no-op (never strand the UI at 同步中)', () => {
    const { statuses } = captureEvents(bus);
    const b = createSyncStatusBroadcaster(ctx);
    b.markAuthRequired('token_rejected', '401');
    const seen = statuses.length;
    b.markSyncing();
    assert.equal(statuses.length, seen);
    assert.equal(b.snapshot().state, 'auth_required');
  });

  it('markSyncing WITH a session is a real retry → syncing', () => {
    const b = createSyncStatusBroadcaster(ctx);
    b.markAuthRequired('missing_session', 'none');
    ctx.skybridgeSession = {} as AppContext['skybridgeSession'];
    b.markSyncing();
    assert.equal(b.snapshot().state, 'syncing');
    assert.equal(b.snapshot().auth_reason, null);
    ctx.skybridgeSession = null;
  });

  it('markSuccess / markSessionInstalled clear it, priority included', () => {
    const b = createSyncStatusBroadcaster(ctx);
    b.markAuthRequired('credentials_missing', 'gone');
    b.markSessionInstalled();
    assert.equal(b.snapshot().state, 'idle');
    assert.equal(b.snapshot().auth_reason, null);
    // Priority is reset with the state — a later weak reason must land.
    b.markAuthRequired('missing_session', 'none');
    assert.equal(b.snapshot().auth_reason, 'missing_session');

    b.markSuccess({});
    assert.equal(b.snapshot().state, 'idle');
    assert.equal(b.snapshot().auth_reason, null);
  });
});
