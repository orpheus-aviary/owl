import Fastify from 'fastify';

export function buildServer() {
  const app = Fastify({ logger: false });

  app.get('/status', async () => {
    return { success: true, data: { status: 'ok' }, message: 'daemon is running' };
  });

  return app;
}
