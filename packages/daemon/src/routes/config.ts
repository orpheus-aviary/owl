import { type OwlConfig, saveConfig } from '@owl/core';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';

/** Recursively merge `delta` into `target` in place. Arrays and primitives overwrite. */
function deepAssign(
  target: Record<string, unknown>,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(delta)) {
    const tv = target[key];
    const dv = delta[key];
    if (
      tv &&
      dv &&
      typeof tv === 'object' &&
      typeof dv === 'object' &&
      !Array.isArray(tv) &&
      !Array.isArray(dv)
    ) {
      deepAssign(tv as Record<string, unknown>, dv as Record<string, unknown>);
    } else if (dv !== undefined) {
      target[key] = dv;
    }
  }
  return target;
}

/** Whitelist of top-level config sections the HTTP API is allowed to patch. */
const ALLOWED_SECTIONS = new Set<keyof OwlConfig>([
  'llm',
  'window',
  'font',
  'navigation',
  'ai',
  'trash',
  'log',
  'shortcuts',
]);

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /config — return current config
  app.get('/config', async (_req, reply) => {
    ok(reply, ctx.config);
  });

  // PATCH /config — deep-merge partial config and persist
  app.patch('/config', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'body must be an object', 'INVALID_BODY');
    }

    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(body)) {
      if (ALLOWED_SECTIONS.has(key as keyof OwlConfig)) {
        filtered[key] = body[key];
      }
    }

    try {
      deepAssign(ctx.config as unknown as Record<string, unknown>, filtered);
      saveConfig(ctx.config, ctx.configPath);
      ok(reply, ctx.config, 'config updated');
    } catch (err) {
      ctx.logger.error({ err }, 'failed to save config');
      fail(reply, 500, 'failed to save config', 'SAVE_FAILED');
    }
  });
}
