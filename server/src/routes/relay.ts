// v8 relay surface, phase 3 (spec/relay.md): relay info, device enrollment
// (via the legacy session — the migration bootstrap path), and the
// challenge → signed-nonce → short-lived-token auth flow (D4/D4b).

import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import { requireAuth } from '../session.js';
import {
  fingerprintB64url,
  generateRelayIdentity,
  issueDeviceToken,
  verifyDeviceSignature,
} from '../relayAuth.js';

const CHALLENGE_MAX_AGE_MS = 2 * 60_000;

function rawKey(b64: string): Buffer | null {
  try {
    const buf = Buffer.from(b64, 'base64');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

export function relayRoutes(app: FastifyInstance, db: DB): void {
  const identity = db.ensureRelayIdentity(generateRelayIdentity);
  const relayFp = fingerprintB64url(Buffer.from(identity.pubkey, 'base64'));

  // Public: the pinned-identity handshake surface (UI-4 shows the name).
  app.get('/api/relay/info', async () => ({
    name: 'Accord relay',
    identityFingerprint: relayFp,
    apiVersion: 1,
  }));

  // Enrollment rides the legacy session for now — exactly the migration
  // bootstrap ("sign in with existing credentials → device key enrolled");
  // QR pairing (D8) becomes the second enrollment path later.
  app.post('/api/relay/devices', { preHandler: requireAuth }, async (request, reply) => {
    const b = request.body as { pubKey?: string; name?: string } | null;
    const raw = b?.pubKey ? rawKey(b.pubKey) : null;
    if (!raw) return reply.code(400).send({ error: 'pubKey must be a base64 32-byte Ed25519 key' });
    const id = fingerprintB64url(raw);
    const enrolled = db.enrollRelayDevice(request.user!.id, id, b!.pubKey!, b?.name ?? null);
    if (!enrolled) return reply.code(409).send({ error: 'device key already enrolled to another account' });
    return { deviceId: enrolled };
  });

  app.get('/api/relay/devices', { preHandler: requireAuth }, async (request) =>
    db.listRelayDevices(request.user!.id),
  );

  app.delete('/api/relay/devices/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.revokeRelayDevice(request.user!.id, id)) {
      return reply.code(404).send({ error: 'unknown device' });
    }
    return { ok: true };
  });

  // Unauthenticated by design: the challenge is the first step of auth.
  app.post('/api/relay/auth/challenge', async () => {
    const nonce = randomBytes(32).toString('base64url');
    db.createRelayChallenge(nonce);
    return { nonce };
  });

  app.post('/api/relay/auth/token', async (request, reply) => {
    const b = request.body as { pubKey?: string; nonce?: string; signature?: string } | null;
    const raw = b?.pubKey ? rawKey(b.pubKey) : null;
    if (!raw || !b?.nonce || !b?.signature) {
      return reply.code(400).send({ error: 'pubKey, nonce, signature required' });
    }
    // Single-use nonce first, so a failed signature still burns it.
    if (!db.consumeRelayChallenge(b.nonce, CHALLENGE_MAX_AGE_MS)) {
      return reply.code(401).send({ error: 'unknown or expired nonce' });
    }
    const device = db.getRelayDeviceByPubkey(b.pubKey!);
    if (!device || device.revoked) return reply.code(401).send({ error: 'unknown or revoked device' });
    // The payload binds the relay's identity: no cross-relay replay (D4b).
    const payload = `${b.nonce}|${relayFp}`;
    if (!verifyDeviceSignature(raw, payload, Buffer.from(b.signature, 'base64'))) {
      return reply.code(401).send({ error: 'bad signature' });
    }
    return { deviceId: device.id, ...issueDeviceToken(device.id) };
  });
}
