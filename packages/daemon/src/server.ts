import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { AppContext } from './context.js';
import { registerConfigRoutes } from './routes/config.js';
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

  // Register routes
  registerNoteRoutes(app, ctx);
  registerTagRoutes(app, ctx);
  registerTodoRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerSystemRoutes(app);

  return app;
}
