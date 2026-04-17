import cors from '@fastify/cors';
import Fastify, { type FastifyError } from 'fastify';
import type { AppContext } from './context.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerFolderRoutes } from './routes/folders.js';
import { registerNoteRoutes } from './routes/notes.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerTagRoutes } from './routes/tags.js';
import { registerTodoRoutes } from './routes/todos.js';

export function buildServer(ctx: AppContext) {
  const app = Fastify({
    logger: false, // We use our own pino logger
  });

  // CORS — allow GUI dev server and Electron renderer
  app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Fastify swallows route-handler throws as a generic 500 without
  // letting us see the stack. Mirror them into our logger so 500s leave
  // a breadcrumb in daemon.log (not just "Internal Server Error" in the
  // GUI console).
  app.setErrorHandler((err: FastifyError, req, reply) => {
    ctx.logger.error(
      {
        err,
        method: req.method,
        url: req.url,
        statusCode: err.statusCode ?? 500,
      },
      'unhandled route error',
    );
    if (reply.sent) return;
    reply.status(err.statusCode ?? 500).send({
      success: false,
      message: err.message || 'Internal Server Error',
      error_code: err.code ?? 'INTERNAL_ERROR',
    });
  });

  // Register routes
  registerNoteRoutes(app, ctx);
  registerFolderRoutes(app, ctx);
  registerTagRoutes(app, ctx);
  registerTodoRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerAiRoutes(app, ctx);
  registerSystemRoutes(app);

  return app;
}
