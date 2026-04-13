import { type LlmConfig, type OwlConfig, resolveLlmConfig, saveConfig } from '@owl/core';
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
  'editor',
  'browser',
  'shortcuts',
]);

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
    };
    const result = await pingLlm(llm);
    if (result.success) {
      ok(reply, result, result.message);
    } else {
      fail(reply, 400, result.message, 'LLM_TEST_FAILED');
    }
  });
}
