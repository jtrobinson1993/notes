// v8 relay surface, phase 3 (spec/relay.md): relay info, device enrollment
// (via the legacy session — the migration bootstrap path), and the
// challenge → signed-nonce → short-lived-token auth flow (D4/D4b).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import { requireAuth } from '../session.js';
import {
  fingerprintB64url,
  generateRelayIdentity,
  issueDeviceToken,
  verifyDeviceSignature,
  verifyDeviceToken,
} from '../relayAuth.js';

const CHALLENGE_MAX_AGE_MS = 2 * 60_000;
const MAILBOX_TTL_MS = 30 * 24 * 60 * 60_000; // D6: undelivered ~30 days
const MAILBOX_FETCH_LIMIT = 200;
const MAX_ENVELOPE_B64 = 256 * 1024; // messages only; blobs get their own store

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

  /** Device-token auth for fetch-side routes (send is deliberately not
   *  device-authenticated — the delivery token is the only credential). */
  function requireDevice(
    request: FastifyRequest,
    reply: FastifyReply,
  ): { id: string; userId: string } | null {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    const deviceId = token ? verifyDeviceToken(token) : null;
    const device = deviceId ? db.getRelayDeviceById(deviceId) : undefined;
    if (!device || device.revoked) {
      void reply.code(401).send({ error: 'device token required' });
      return null;
    }
    return { id: device.id, userId: device.userId };
  }

  // Relay timestamps are non-decreasing within this process (D11 ordering).
  let lastTs = 0;
  function stampTs(): number {
    lastTs = Math.max(lastTs + 1, Date.now());
    return lastTs;
  }

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

  // ---- sealed-sender mailbox (D6) ----

  // Recipient registers hash(delivery token). Device-token authed: only the
  // account's own devices may rotate its verifier.
  app.put('/api/relay/verifier', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const b = request.body as { verifier?: string } | null;
    if (!b?.verifier || b.verifier.length > 128) {
      return reply.code(400).send({ error: 'verifier required' });
    }
    db.setRelayVerifier(device.userId, b.verifier);
    return { ok: true };
  });

  // Sealed send: NO device token — the delivery token is the only credential,
  // so the relay never links an envelope to a sender account (D6). Uniform
  // 401 for bad handle/verifier/token: no handle enumeration via probes.
  app.post('/api/relay/mailbox/send', async (request, reply) => {
    const b = request.body as
      | { deliveryToken?: string; recipientHandle?: string; envelope?: string }
      | null;
    if (!b?.deliveryToken || !b?.recipientHandle || !b?.envelope) {
      return reply.code(400).send({ error: 'deliveryToken, recipientHandle, envelope required' });
    }
    if (b.envelope.length > MAX_ENVELOPE_B64) {
      return reply.code(413).send({ error: 'envelope too large' });
    }
    const user = db.getUserByHandle(b.recipientHandle);
    const verifier = user ? db.getRelayVerifier(user.id) : undefined;
    const presented = createHash('sha256').update(b.deliveryToken).digest('base64url');
    if (!user || !verifier || presented !== verifier) {
      return reply.code(401).send({ error: 'delivery refused' });
    }
    const devices = db.activeRelayDeviceIds(user.id);
    const relayTs = stampTs();
    if (devices.length) {
      db.enqueueRelayEnvelope(devices, relayTs, Buffer.from(b.envelope, 'base64'));
    }
    db.pruneRelayMailbox(MAILBOX_TTL_MS); // opportunistic TTL sweep
    return { relayTs };
  });

  app.get('/api/relay/mailbox', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const rows = db.fetchRelayMailbox(device.id, MAILBOX_FETCH_LIMIT);
    return rows.map((r) => ({
      queueId: r.queueId,
      relayTs: r.relayTs,
      envelope: r.envelope.toString('base64'),
    }));
  });

  app.post('/api/relay/mailbox/ack', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const b = request.body as { queueIds?: number[] } | null;
    if (!Array.isArray(b?.queueIds) || b.queueIds.some((q) => !Number.isInteger(q))) {
      return reply.code(400).send({ error: 'queueIds required' });
    }
    return { acked: db.ackRelayMailbox(device.id, b.queueIds) };
  });

  // ---- account escrow (D15) ----

  // Upload/refresh the wrapped-MK escrow bundle. The payload is opaque to
  // the relay: MK wrapped under user-held secrets, plus public KDF params.
  app.put('/api/relay/escrow', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const b = request.body as
      | { payload?: string; passwordAuthHash?: string; recoveryAuthHash?: string }
      | null;
    if (!b?.payload || b.payload.length > 8192) {
      return reply.code(400).send({ error: 'payload required (max 8KB)' });
    }
    db.setRelayEscrow(device.userId, b.payload, b.passwordAuthHash ?? null, b.recoveryAuthHash ?? null);
    return { ok: true };
  });

  // Cold-start fetch: prove knowledge of the domain-separated auth key
  // (derived from the password or recovery code — a different HKDF domain
  // than the wrap key, so it can't unwrap anything). Uniform 401; tight
  // per-IP rate limit because these blobs are offline brute-force targets.
  app.post(
    '/api/relay/escrow/fetch',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const b = request.body as
        | { handle?: string; authKind?: 'password' | 'recovery'; authKey?: string }
        | null;
      if (!b?.handle || !b?.authKey || (b.authKind !== 'password' && b.authKind !== 'recovery')) {
        return reply.code(400).send({ error: 'handle, authKind, authKey required' });
      }
      const user = db.getUserByHandle(b.handle);
      const escrow = user ? db.getRelayEscrow(user.id) : undefined;
      const stored = b.authKind === 'password' ? escrow?.passwordAuthHash : escrow?.recoveryAuthHash;
      const presented = createHash('sha256').update(Buffer.from(b.authKey, 'base64')).digest('base64url');
      if (!escrow || !stored || presented !== stored) {
        return reply.code(401).send({ error: 'escrow fetch refused' });
      }
      return { payload: escrow.payload };
    },
  );

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
