import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { registerSecurityHeaders } from './security-headers.js';
import { registerSessionHooks } from './session.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { noteRoutes } from './routes/notes.js';
import { attachmentRoutes } from './routes/attachments.js';
import { settingsRoutes } from './routes/settings.js';
import { chatRoutes } from './routes/chat.js';
import { linkRoutes } from './routes/link.js';
import { gifRoutes } from './routes/gifs.js';
import { emojiRoutes } from './routes/emoji.js';
import { ogRoutes } from './routes/og.js';
import { createRealtime, WS_MAX_PAYLOAD } from './realtime.js';

export async function buildApp(db: DB, config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

  await app.register(fastifyCookie);

  // Resolve the built SPA shell up front: its inline scripts feed the CSP
  // script-src hashes, and its presence decides whether we serve static assets.
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = config.webDist ?? resolve(here, '../../web/dist');
  const indexPath = join(webDist, 'index.html');
  const hasWebDist = existsSync(indexPath);
  const indexHtml = hasWebDist ? readFileSync(indexPath, 'utf8') : null;

  // CSP + hardening headers on every response (defense-in-depth).
  registerSecurityHeaders(app, config, indexHtml);

  // Global per-IP rate limit. Deliberately liberal so normal use is never
  // throttled — it exists to cap abuse (credential guessing, proxy/upload
  // hammering) rather than to police real traffic. Routes that want a tighter
  // ceiling (e.g. the auth ceremony) set `config.rateLimit` per route.
  await app.register(fastifyRateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD } });
  registerSessionHooks(app, db, config);

  const realtime = createRealtime(db, config);

  app.get('/api/health', async () => ({ ok: true }));
  authRoutes(app, db, config);
  adminRoutes(app, db, config);
  noteRoutes(app, db);
  attachmentRoutes(app, db, config);
  settingsRoutes(app, db);
  chatRoutes(app, db, realtime);
  linkRoutes(app, db, config);
  gifRoutes(app, config);
  emojiRoutes(app, config);
  ogRoutes(app);
  realtime.register(app);

  // Serve the built SPA (resolved above). Default: web/dist relative to the repo
  // layout (works both from source and inside the Docker image).
  if (hasWebDist) {
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
