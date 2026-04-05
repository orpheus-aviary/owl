import Fastify from 'fastify';
import type { AppContext } from './context.js';
import { registerNoteRoutes } from './routes/notes.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerTagRoutes } from './routes/tags.js';

export function buildServer(ctx: AppContext) {
  const app = Fastify({
    logger: false, // We use our own pino logger
  });

  // Register routes
  registerNoteRoutes(app, ctx);
  registerTagRoutes(app, ctx);
  registerSystemRoutes(app);

  return app;
}
