import { parseTag, schema } from '@owl/core';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';

export function registerTagRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /tags — list # tags (for autocomplete)
  app.get('/tags', async (req, reply) => {
    const query = req.query as { search?: string };

    const baseCondition = eq(schema.tags.tagType, '#');
    const rows = query.search
      ? ctx.db
          .select()
          .from(schema.tags)
          .where(and(baseCondition, sql`${schema.tags.tagValue} LIKE ${`%${query.search}%`}`))
          .all()
      : ctx.db.select().from(schema.tags).where(baseCondition).all();

    ok(reply, rows);
  });

  // GET /tags/frequent — top N frequent tags
  app.get('/tags/frequent', async (req, reply) => {
    const query = req.query as { limit?: string };
    const limit = query.limit ? Number(query.limit) : 10;

    const rows = ctx.sqlite
      .prepare(
        `SELECT t.id, t.tag_type, t.tag_value, COUNT(nt.note_id) as usage_count
         FROM tags t
         JOIN note_tags nt ON t.id = nt.tag_id
         JOIN notes n ON nt.note_id = n.id AND n.trash_level = 0
         WHERE t.tag_type = '#'
         GROUP BY t.id
         ORDER BY usage_count DESC
         LIMIT ?`,
      )
      .all(limit);

    ok(reply, rows);
  });

  // POST /parse-tag — parse a raw tag string
  app.post('/parse-tag', async (req, reply) => {
    const body = req.body as { raw: string };
    if (!body.raw) return fail(reply, 400, 'Raw tag string required', 'MISSING_RAW');

    const parsed = parseTag(body.raw);
    if (!parsed) return fail(reply, 400, 'Invalid tag format', 'INVALID_TAG');

    ok(reply, parsed);
  });

  // GET /reminders — reminders in date range
  app.get('/reminders', async (req, reply) => {
    const query = req.query as { from?: string; to?: string };
    if (!query.from || !query.to) {
      return fail(reply, 400, 'from and to parameters required', 'MISSING_RANGE');
    }

    const rows = ctx.sqlite
      .prepare(
        `SELECT DISTINCT n.*, t.tag_type, t.tag_value
         FROM notes n
         JOIN note_tags nt ON n.id = nt.note_id
         JOIN tags t ON nt.tag_id = t.id
         WHERE t.tag_type IN ('/alarm', '/time')
         AND t.tag_value >= ? AND t.tag_value <= ?
         AND n.trash_level = 0
         ORDER BY t.tag_value ASC`,
      )
      .all(query.from, query.to);

    ok(reply, rows);
  });

  // GET /reminders/upcoming — upcoming reminders within N minutes
  app.get('/reminders/upcoming', async (req, reply) => {
    const query = req.query as { within_minutes?: string };
    const minutes = query.within_minutes ? Number(query.within_minutes) : 30;
    const now = new Date();
    const future = new Date(now.getTime() + minutes * 60 * 1000);

    const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
    const fromStr = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const toStr = `${pad(future.getFullYear(), 4)}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}:${pad(future.getSeconds())}`;

    const rows = ctx.sqlite
      .prepare(
        `SELECT DISTINCT n.*, t.tag_type, t.tag_value
         FROM notes n
         JOIN note_tags nt ON n.id = nt.note_id
         JOIN tags t ON nt.tag_id = t.id
         WHERE t.tag_type IN ('/alarm', '/time')
         AND t.tag_value >= ? AND t.tag_value <= ?
         AND n.trash_level = 0
         ORDER BY t.tag_value ASC`,
      )
      .all(fromStr, toStr);

    ok(reply, rows);
  });
}
