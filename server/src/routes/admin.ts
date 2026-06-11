import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { toInviteInfo, toUserInfo, type DB } from '../db.js';
import { requireAdmin } from '../session.js';
import { newId, newToken, now } from '../util.js';

export function adminRoutes(app: FastifyInstance, db: DB, config: Config): void {
  app.post('/api/invites', { preHandler: requireAdmin }, async (request) => {
    const { expiresInHours } = (request.body ?? {}) as { expiresInHours?: unknown };
    const hours = typeof expiresInHours === 'number' && expiresInHours > 0 && expiresInHours <= 24 * 30
      ? expiresInHours
      : 7 * 24;
    const invite = {
      id: newId(),
      token: newToken(),
      createdBy: request.user!.id,
      expiresAt: now() + hours * 60 * 60 * 1000,
    };
    db.createInvite(invite);
    return {
      ...toInviteInfo({ ...invite, created_by: invite.createdBy, created_at: now(), expires_at: invite.expiresAt, used_by: null }),
      url: `${config.appOrigin}/invite/${invite.token}`,
    };
  });

  app.get('/api/invites', { preHandler: requireAdmin }, async () => {
    return db.listInvites().map((i) => ({ ...toInviteInfo(i), url: `${config.appOrigin}/invite/${i.token}` }));
  });

  app.delete('/api/invites/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.listInvites().some((i) => i.id === id)) return reply.code(404).send({ error: 'not found' });
    db.deleteInvite(id);
    return { ok: true };
  });

  app.get('/api/users', { preHandler: requireAdmin }, async () => {
    return db.listUsers().map(toUserInfo);
  });

  app.delete('/api/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === request.user!.id) return reply.code(400).send({ error: 'cannot delete yourself' });
    if (!db.getUser(id)) return reply.code(404).send({ error: 'not found' });
    db.deleteUser(id);
    return { ok: true };
  });
}
