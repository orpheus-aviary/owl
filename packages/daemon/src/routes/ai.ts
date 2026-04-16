import { resolveLlmConfig } from '@owl/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type AgentEvent, runAgentLoop } from '../ai/agent-loop.js';
import { createLlmClient } from '../ai/llm-client.js';
import { endSse, initSse, sendSseEvent } from '../ai/sse.js';
import type { ToolSource } from '../ai/tool-registry.js';
import { applyPreview } from '../ai/tools/apply-update.js';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';

interface ChatBody {
  message?: unknown;
  conversation_id?: unknown;
  /** 'gui' (default) or 'external' — switches Tier-2 write behaviour. */
  source?: unknown;
}

const ALLOWED_SOURCES: readonly ToolSource[] = ['gui', 'external'];

export function registerAiRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── POST /ai/chat — SSE-streamed agent loop ─────────────────────────
  app.post('/ai/chat', async (req, reply) => {
    const body = (req.body ?? {}) as ChatBody;
    const validation = validateChatBody(body);
    if (!validation.ok) {
      fail(reply, 400, validation.error);
      return;
    }

    const llmConfig = resolveLlmConfig(ctx.config);
    if (!llmConfig.url || !llmConfig.model || !llmConfig.api_key) {
      fail(reply, 400, 'LLM not configured (url / model / api_key required)');
      return;
    }

    let llmClient: ReturnType<typeof createLlmClient>;
    try {
      llmClient = (ctx.llmClientFactory ?? createLlmClient)(llmConfig);
    } catch (err) {
      fail(reply, 400, err instanceof Error ? err.message : String(err));
      return;
    }

    initSse(reply);
    const abort = wireClientDisconnect(req, reply);

    try {
      const generator = runAgentLoop(
        {
          message: validation.message,
          conversationId: validation.conversationId,
          signal: abort.signal,
        },
        {
          llmClient,
          registry: ctx.toolRegistry,
          conversations: ctx.conversationStore,
          db: ctx.db,
          sqlite: ctx.sqlite,
          config: ctx.config,
          toolCtx: {
            db: ctx.db,
            sqlite: ctx.sqlite,
            config: ctx.config,
            deviceId: ctx.deviceId,
            scheduler: ctx.scheduler,
            source: validation.source,
            logger: ctx.logger,
            previewStore: ctx.previewStore,
          },
        },
      );

      for await (const event of generator) {
        if (reply.raw.writableEnded) break;
        sendSseEvent(reply, event.type, eventPayload(event));
      }
    } catch (err) {
      ctx.logger.error({ err }, 'agent loop crashed');
      sendSseEvent(reply, 'error', { message: err instanceof Error ? err.message : String(err) });
    } finally {
      abort.cleanup();
      endSse(reply);
    }
  });

  // ── GET /ai/conversations — list active conversations ───────────────
  app.get('/ai/conversations', async (_req, reply) => {
    const list = ctx.conversationStore.list().map((c) => ({
      id: c.id,
      created_at: c.createdAt.toISOString(),
      updated_at: c.updatedAt.toISOString(),
      message_count: c.messageCount,
    }));
    ok(reply, { conversations: list });
  });

  // ── DELETE /ai/conversations/:id — clear a conversation ─────────────
  app.delete<{ Params: { id: string } }>('/ai/conversations/:id', async (req, reply) => {
    const { id } = req.params;
    const removed = ctx.conversationStore.delete(id);
    if (!removed) {
      fail(reply, 404, `conversation not found: ${id}`);
      return;
    }
    ok(reply, { id }, 'conversation cleared');
  });

  // ── GET /ai/capabilities — describe registered tools ────────────────
  app.get('/ai/capabilities', async (_req, reply) => {
    const tools = ctx.toolRegistry.all().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
    ok(reply, { tools });
  });

  // ── GET /ai/previews — list active external-agent previews ──────────
  app.get('/ai/previews', async (_req, reply) => {
    const previews = ctx.previewStore.list().map((p) => ({
      id: p.id,
      action: p.payload.action,
      note_id: p.payload.note_id,
      content: p.payload.content,
      tags: p.payload.tags,
      folder_id: p.payload.folder_id ?? null,
      created_at: p.createdAt.toISOString(),
      expires_at: p.expiresAt.toISOString(),
    }));
    ok(reply, { previews });
  });

  // ── POST /ai/preview/apply — commit a stored preview ────────────────
  app.post<{ Body: { preview_id?: unknown } }>('/ai/preview/apply', async (req, reply) => {
    const previewId = typeof req.body?.preview_id === 'string' ? req.body.preview_id.trim() : '';
    if (!previewId) {
      fail(reply, 400, 'preview_id is required');
      return;
    }
    const stored = ctx.previewStore.consume(previewId);
    if (!stored) {
      fail(reply, 404, `preview not found or expired: ${previewId}`);
      return;
    }
    const result = applyPreview(stored, ctx.db, ctx.sqlite, ctx.deviceId, ctx.scheduler);
    if ('error' in result) {
      fail(reply, 400, result.error);
      return;
    }
    ok(reply, result, result.message);
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────

type ChatValidation =
  | { ok: true; message: string; conversationId: string | undefined; source: ToolSource }
  | { ok: false; error: string };

function validateChatBody(body: ChatBody): ChatValidation {
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return { ok: false, error: 'message is required and must be a non-empty string' };

  const conversationId =
    typeof body.conversation_id === 'string' && body.conversation_id.trim()
      ? body.conversation_id.trim()
      : undefined;

  let source: ToolSource = 'gui';
  if (body.source !== undefined) {
    if (typeof body.source !== 'string' || !ALLOWED_SOURCES.includes(body.source as ToolSource)) {
      return { ok: false, error: `source must be one of ${ALLOWED_SOURCES.join(', ')}` };
    }
    source = body.source as ToolSource;
  }

  return { ok: true, message, conversationId, source };
}

interface AbortHandle {
  signal: AbortSignal;
  cleanup: () => void;
}

/**
 * Wire the underlying socket's `close` event to an AbortController so the
 * agent loop can stop streaming when the client disconnects mid-response.
 */
function wireClientDisconnect(req: FastifyRequest, _reply: FastifyReply): AbortHandle {
  const controller = new AbortController();
  const onClose = () => controller.abort(new Error('client disconnected'));
  req.raw.on('close', onClose);
  return {
    signal: controller.signal,
    cleanup: () => req.raw.off('close', onClose),
  };
}

/**
 * Strip the `type` discriminator from the event before sending — clients
 * already receive it via the SSE `event:` line, so duplicating it on the
 * payload just bloats the wire format.
 */
function eventPayload(event: AgentEvent): Record<string, unknown> {
  const { type: _type, ...rest } = event;
  return rest;
}
