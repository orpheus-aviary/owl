import { LOCAL_AUTH_VERSION } from '@orpheus-aviary/owl-shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { ok } from '../response.js';
import { readLastSyncSuccessAt } from '../sync/last-success.js';
import { syncTriggerReady } from '../sync/trigger-gate.js';

/**
 * 0.6.3 V3 — the cloud sync health a monitor can poll without a token.
 *
 * A deliberately separate projection, NOT the internal `SyncState`. After a
 * restart a cloud daemon holds neither credentials nor session, so
 * `isAccountProfile` is false and the broadcaster's initial state is `idle` —
 * publishing that would tell a monitor everything is fine while nothing is
 * syncing.
 *
 * `session_ready` means exactly "a session is installed", nothing more: not
 * that skybridge is reachable, not that the last round succeeded. Liveness
 * checks must combine it with `last_success_at`, which is why the field is
 * here and why the runbook says to look at both.
 *
 * Field set is closed on purpose — `/status` is unauthenticated in both modes,
 * so nothing identifying (token, email, profile id, workspace, device, server
 * url) may appear here. A route test asserts the exact key set.
 */
interface SyncHealth {
  session_installed: boolean;
  state: 'session_ready' | 'login_required';
  last_success_at: number | null;
}

function cloudSyncHealth(ctx: AppContext): SyncHealth {
  const ready = syncTriggerReady(ctx);
  return {
    session_installed: ready,
    state: ready ? 'session_ready' : 'login_required',
    last_success_at: readLastSyncSuccessAt(ctx),
  };
}

export function registerSystemRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /status — health check. Public in both modes (GUI/CLI probe it before
  // they can authenticate). A6 — advertises `mode`, and in LOCAL mode the daemon
  // pid + `local_auth_version` so GUI main can detect+replace a stale pre-A6
  // daemon; cloud omits pid (don't leak the OS pid) and local_auth_version.
  app.get('/status', async (_req, reply) => {
    const mode = ctx.config.daemon.mode;
    const payload: {
      status: string;
      uptime: number;
      mode: 'local' | 'cloud';
      pid?: number;
      local_auth_version?: number;
      sync?: SyncHealth;
    } = { status: 'ok', uptime: process.uptime(), mode };
    if (mode === 'local') {
      payload.pid = process.pid;
      payload.local_auth_version = LOCAL_AUTH_VERSION;
    } else {
      payload.sync = cloudSyncHealth(ctx);
    }
    ok(reply, payload, 'daemon is running');
  });

  // GET /api/capabilities — describe all available endpoints
  app.get('/api/capabilities', async (_req, reply) => {
    ok(reply, {
      endpoints: [
        { method: 'GET', path: '/notes', description: 'List notes with search and filters' },
        { method: 'GET', path: '/notes/:id', description: 'Get a single note with tags' },
        { method: 'POST', path: '/notes', description: 'Create a new note' },
        { method: 'PUT', path: '/notes/:id', description: 'Full update of a note' },
        { method: 'PATCH', path: '/notes/:id', description: 'Partial update of a note' },
        { method: 'DELETE', path: '/notes/:id', description: 'Move note to trash' },
        { method: 'POST', path: '/notes/:id/restore', description: 'Restore note from trash' },
        {
          method: 'POST',
          path: '/notes/:id/permanent-delete',
          description: 'Permanently delete a note',
        },
        { method: 'POST', path: '/notes/batch-delete', description: 'Batch move notes to trash' },
        { method: 'POST', path: '/notes/batch-restore', description: 'Batch restore notes' },
        { method: 'GET', path: '/tags', description: 'List # tags for autocomplete' },
        { method: 'GET', path: '/tags/frequent', description: 'Get most used tags' },
        { method: 'POST', path: '/parse-tag', description: 'Parse a raw tag string' },
        { method: 'GET', path: '/reminders', description: 'Get reminders in date range' },
        { method: 'GET', path: '/reminders/upcoming', description: 'Get upcoming reminders' },
        { method: 'GET', path: '/reminders/alarms', description: 'Get all notes with alarm tags' },
        { method: 'GET', path: '/config', description: 'Get current owl config' },
        { method: 'PATCH', path: '/config', description: 'Partial update of owl config' },
        { method: 'POST', path: '/ai/chat', description: 'Stream agent chat (SSE)' },
        { method: 'GET', path: '/ai/conversations', description: 'List active AI conversations' },
        {
          method: 'DELETE',
          path: '/ai/conversations/:id',
          description: 'Clear an AI conversation',
        },
        { method: 'GET', path: '/ai/capabilities', description: 'Describe AI tool registry' },
        { method: 'GET', path: '/ai/previews', description: 'List staged external-agent previews' },
        { method: 'POST', path: '/ai/preview/apply', description: 'Commit a staged preview' },
        { method: 'GET', path: '/status', description: 'Health check' },
        { method: 'GET', path: '/api/capabilities', description: 'List all endpoints' },
        { method: 'POST', path: '/sync/run', description: 'Trigger one skybridge sync round' },
        { method: 'GET', path: '/sync/status', description: 'Skybridge sync status snapshot' },
        {
          method: 'POST',
          path: '/sync/session',
          description: 'Install skybridge session (replace semantics, GUI-main → daemon)',
        },
        {
          method: 'POST',
          path: '/sync/auth-unrecoverable',
          description: 'Credentials wiped by GUI main — stop syncing until re-login',
        },
      ],
    });
  });
}
