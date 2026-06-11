import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { DB, UserRow } from './db.js';
import { newToken, now, sha256b64 } from './util.js';

export const SESSION_COOKIE = 'notes_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    sessionId: string | null;
    sessionRecovery: boolean;
  }
}

export function startSession(db: DB, config: Config, reply: FastifyReply, userId: string, recovery = false): void {
  const token = newToken();
  db.createSession({ id: sha256b64(token), userId, expiresAt: now() + SESSION_TTL, recovery });
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.appOrigin.startsWith('https://'),
    maxAge: SESSION_TTL / 1000,
  });
}

export function endSession(db: DB, request: FastifyRequest, reply: FastifyReply): void {
  if (request.sessionId) db.deleteSession(request.sessionId);
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function registerSessionHooks(app: FastifyInstance, db: DB, config: Config): void {
  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);
  app.decorateRequest('sessionRecovery', false);

  app.addHook('onRequest', async (request, reply) => {
    // CSRF defence: mutating API requests must come from our own origin.
    if (request.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== config.appOrigin) {
        return reply.code(403).send({ error: 'cross-origin request rejected' });
      }
    }

    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = db.getSession(sha256b64(token));
    if (!session) return;
    const user = db.getUser(session.user_id);
    if (!user) return;
    request.user = user;
    request.sessionId = session.id;
    request.sessionRecovery = session.recovery === 1;
  });
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    reply.code(401).send({ error: 'not authenticated' });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    reply.code(401).send({ error: 'not authenticated' });
  } else if (request.user.role !== 'admin') {
    reply.code(403).send({ error: 'admin only' });
  }
}
