import {
  type LlmConfig,
  type OwlConfig,
  redactConfig,
  resolveLlmConfig,
  saveConfig,
} from '@owl/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Session, isConfigOwner } from '../auth.js';
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

/**
 * Validate the incoming config patch values. Returns `null` if OK, or an
 * error message string describing the first violation. Structural filtering
 * (section whitelist) happens separately — this only checks values inside
 * already-allowed sections.
 */
function validatePatch(filtered: Record<string, unknown>): string | null {
  const trash = filtered.trash;
  if (trash && typeof trash === 'object') {
    const days = (trash as { auto_delete_days?: unknown }).auto_delete_days;
    if (days !== undefined) {
      if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 3650) {
        return 'trash.auto_delete_days must be an integer between 1 and 3650';
      }
    }
  }
  return null;
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
  'editor',
  'browser',
  'shortcuts',
]);

/** Drop any body keys outside the whitelist (so a stray `daemon` can't slip in). */
function filterAllowedSections(body: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (ALLOWED_SECTIONS.has(key as keyof OwlConfig)) {
      filtered[key] = body[key];
    }
  }
  return filtered;
}

/** Send a minimal "ping" message to the given LLM endpoint and report success. */
async function pingLlm(llm: LlmConfig): Promise<{ success: boolean; message: string }> {
  if (!llm.url || !llm.model || !llm.api_key) {
    return { success: false, message: 'url / model / api_key 任一为空' };
  }

  try {
    if (llm.api_format === 'anthropic') {
      const endpoint = `${llm.url.replace(/\/$/, '')}/messages`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': llm.api_key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: llm.model,
          max_tokens: 5,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { success: false, message: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      return { success: true, message: 'Anthropic 连接成功' };
    }

    // Default: OpenAI-compatible
    const endpoint = `${llm.url.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${llm.api_key}`,
      },
      body: JSON.stringify({
        model: llm.model,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { success: false, message: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return { success: true, message: 'OpenAI 连接成功' };
  } catch (err) {
    return { success: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Read the Layer-2 session attached by the cloud auth preHandler, if any. */
function sessionOf(req: FastifyRequest): Session | undefined {
  return (req as { session?: Session }).session;
}

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  // GET /config — return current config, redacted for a non-owner cloud session
  // (api_key stripped, has_api_key flagged; A5 secret redaction).
  app.get('/config', async (req, reply) => {
    const owner = isConfigOwner(ctx, sessionOf(req));
    ok(reply, redactConfig(ctx.config, { owner }));
  });

  // PATCH /config — deep-merge partial config and persist. `llm.*` is
  // owner-gated (A5); the response is redacted the same as GET.
  app.patch('/config', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== 'object') {
      return fail(reply, 400, 'body must be an object', 'INVALID_BODY');
    }

    const owner = isConfigOwner(ctx, sessionOf(req));
    if (!owner && 'llm' in body) {
      return fail(reply, 403, 'llm config is owner-only', 'FORBIDDEN');
    }

    const filtered = filterAllowedSections(body);

    // Value-level validation (e.g. auto_delete_days=0 would defeat the
    // level-2 review buffer). The GUI already clamps these, but external
    // agents hitting the daemon directly shouldn't be able to poison config.
    const validationError = validatePatch(filtered);
    if (validationError) {
      return fail(reply, 400, validationError, 'INVALID_CONFIG');
    }

    try {
      deepAssign(ctx.config as unknown as Record<string, unknown>, filtered);
      saveConfig(ctx.config, ctx.configPath);
      // When the trash auto-delete threshold changes, recompute all sticky
      // deadlines and rearm the cleanup timer. This only ever pulls deadlines
      // earlier — never extends them — so it's safe to run on any patch.
      if ('trash' in filtered) {
        ctx.scheduler.onTrashThresholdChanged();
      }
      ok(reply, redactConfig(ctx.config, { owner }), 'config updated');
    } catch (err) {
      ctx.logger.error({ err }, 'failed to save config');
      fail(reply, 500, 'failed to save config', 'SAVE_FAILED');
    }
  });

  // POST /llm/test — verify current LLM config reachable. Optional body may
  // override url/model/api_key/api_format so the GUI can test unsaved edits.
  app.post('/llm/test', async (req, reply) => {
    const override = (req.body ?? {}) as Partial<LlmConfig>;
    const base = resolveLlmConfig(ctx.config);
    const llm: LlmConfig = {
      url: override.url ?? base.url,
      model: override.model ?? base.model,
      api_key: override.api_key ?? base.api_key,
      api_format: override.api_format ?? base.api_format ?? 'openai',
      // Test endpoint sends a single ping with no thinking — round_trip
      // doesn't actually matter here, but keep the type complete.
      thinking_round_trip: override.thinking_round_trip ?? base.thinking_round_trip ?? true,
    };
    const result = await pingLlm(llm);
    if (result.success) {
      ok(reply, result, result.message);
    } else {
      fail(reply, 400, result.message, 'LLM_TEST_FAILED');
    }
  });
}
