import type { FastifyInstance } from 'fastify';
import { ok } from '../response.js';

export function registerSystemRoutes(app: FastifyInstance): void {
  // GET /status — health check
  app.get('/status', async (_req, reply) => {
    ok(reply, { status: 'ok', uptime: process.uptime() }, 'daemon is running');
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
        { method: 'GET', path: '/status', description: 'Health check' },
        { method: 'GET', path: '/api/capabilities', description: 'List all endpoints' },
      ],
    });
  });
}
