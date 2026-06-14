import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { SealedKey } from '@notes/shared';
import { effectiveDisplayName, toUserInfo, type DB } from '../db.js';
import type { Config } from '../config.js';
import { requireAuth, startSession } from '../session.js';
import { newId, newToken, now, sha256b64 } from '../util.js';

// Cross-device onboarding ("device linking"). A logged-in device seals the
// master key to a NEW device's ephemeral X25519 public key; the server only
// ever relays the sealed blob (ciphertext) and never sees plaintext MK. The
// human-verified channel is the short `code` (typed from the new device into
// the logged-in one) plus a client-computed SAS over (code, devicePublicKey).
// See spec/accounts-and-crypto.md.

const LINK_TTL = 5 * 60_000; // 5 minutes
// Unambiguous uppercase alphabet (no I/L/O/0/1), ~40 bits over 8 chars.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode(): string {
  let s = '';
  for (const b of randomBytes(8)) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}

function validSealedKey(s: unknown): s is SealedKey {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.epk === 'string' && o.epk.length > 0 && o.epk.length < 256 &&
    typeof o.iv === 'string' && o.iv.length > 0 && o.iv.length < 256 &&
    typeof o.ct === 'string' && o.ct.length > 0 && o.ct.length < 1024
  );
}

export function linkRoutes(app: FastifyInstance, db: DB, config: Config): void {
  // ---- New device: start a link (no auth — it has no account yet) ----
  app.post('/api/link/init', async (request, reply) => {
    db.purgeExpiredDeviceLinks();
    const b = request.body as Record<string, unknown> | null;
    const devicePublicKey = b?.devicePublicKey;
    if (typeof devicePublicKey !== 'string' || devicePublicKey.length < 1 || devicePublicKey.length > 100) {
      return reply.code(400).send({ error: 'invalid devicePublicKey' });
    }
    // Unique code (retry on the astronomically rare collision).
    let code = makeCode();
    for (let i = 0; i < 5 && db.getDeviceLinkByCode(code); i++) code = makeCode();
    const secret = newToken();
    db.createDeviceLink({
      id: newId(),
      code,
      secretHash: sha256b64(secret),
      devicePublicKey,
      expiresAt: now() + LINK_TTL,
    });
    // `secret` is the new device's bearer token (poll/complete); `code` is shown
    // to the user to type into the logged-in device.
    return { code, secret, expiresAt: now() + LINK_TTL };
  });

  // ---- Logged-in device: fetch the pending device's public key (to compute
  // the SAS and seal MK to it) ----
  app.get('/api/link/:code', { preHandler: requireAuth }, async (request, reply) => {
    const code = String((request.params as { code: string }).code).toUpperCase();
    const link = db.getDeviceLinkByCode(code);
    if (!link || link.completed) return reply.code(404).send({ error: 'link not found' });
    return { devicePublicKey: link.device_public_key, sealed: link.sealed_mk !== null };
  });

  // ---- Logged-in device: seal MK to the new device (binds the link) ----
  app.post('/api/link/:code/seal', { preHandler: requireAuth }, async (request, reply) => {
    const code = String((request.params as { code: string }).code).toUpperCase();
    const b = request.body as Record<string, unknown> | null;
    if (!validSealedKey(b?.sealedMk)) return reply.code(400).send({ error: 'invalid sealedMk' });
    const link = db.getDeviceLinkByCode(code);
    if (!link || link.completed) return reply.code(404).send({ error: 'link not found' });
    // Single-use: only the first seal wins.
    if (!db.sealDeviceLink(link.id, request.user!.id, JSON.stringify(b!.sealedMk))) {
      return reply.code(409).send({ error: 'link already used' });
    }
    return { ok: true };
  });

  // ---- New device: poll for the sealed MK (auth via the init secret) ----
  app.post('/api/link/:code/poll', async (request, reply) => {
    const code = String((request.params as { code: string }).code).toUpperCase();
    const b = request.body as Record<string, unknown> | null;
    if (typeof b?.secret !== 'string') return reply.code(400).send({ error: 'missing secret' });
    const link = db.getDeviceLinkByCode(code);
    if (!link || link.completed || link.secret_hash !== sha256b64(b.secret)) {
      return reply.code(404).send({ error: 'link not found' });
    }
    if (!link.sealed_mk || !link.user_id) return { status: 'pending' };
    const u = db.getUser(link.user_id);
    if (!u) return reply.code(410).send({ error: 'account gone' });
    // Surface the target account so the new device can confirm before finishing.
    return {
      status: 'sealed',
      sealedMk: JSON.parse(link.sealed_mk) as SealedKey,
      user: { ...toUserInfo(u), displayName: effectiveDisplayName(u) },
    };
  });

  // ---- New device: finish — consume the link and start a session ----
  app.post('/api/link/:code/complete', async (request, reply) => {
    const code = String((request.params as { code: string }).code).toUpperCase();
    const b = request.body as Record<string, unknown> | null;
    if (typeof b?.secret !== 'string') return reply.code(400).send({ error: 'missing secret' });
    const link = db.getDeviceLinkByCode(code);
    if (!link || link.completed || link.secret_hash !== sha256b64(b.secret)) {
      return reply.code(404).send({ error: 'link not found' });
    }
    if (!link.user_id || !link.sealed_mk) return reply.code(409).send({ error: 'link not sealed yet' });
    // Single-use: consume the link, then issue a session for the sealed user so
    // the new device can register its own passkey via /api/me/credentials/*.
    if (!db.completeDeviceLink(link.id)) return reply.code(409).send({ error: 'link already used' });
    const user = db.getUser(link.user_id);
    if (!user) return reply.code(410).send({ error: 'account gone' });
    db.deleteDeviceLink(link.id);
    startSession(db, config, reply, user.id);
    return { user: toUserInfo(user) };
  });
}
