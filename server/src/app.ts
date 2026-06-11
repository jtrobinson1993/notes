import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { registerSessionHooks } from './session.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { noteRoutes } from './routes/notes.js';
import { attachmentRoutes } from './routes/attachments.js';

export async function buildApp(db: DB, config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

  await app.register(fastifyCookie);
  registerSessionHooks(app, db, config);

  app.get('/api/health', async () => ({ ok: true }));
  authRoutes(app, db, config);
  adminRoutes(app, db, config);
  noteRoutes(app, db);
  attachmentRoutes(app, db, config);

  // Serve the built SPA. Default: web/dist relative to the repo layout
  // (works both from source and inside the Docker image).
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = config.webDist ?? resolve(here, '../../web/dist');
  if (existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.log.warn(`web dist not found at ${webDist}; serving API only`);
  }

  return app;
}
