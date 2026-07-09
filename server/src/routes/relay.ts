// v8 relay surface, phase 3 (spec/relay.md): relay info, device enrollment
// (via the legacy session — the migration bootstrap path), and the
// challenge → signed-nonce → short-lived-token auth flow (D4/D4b).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, createPrivateKey, randomBytes, sign as edSign } from 'node:crypto';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { RelayLive } from '../relayLive.js';
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

export function relayRoutes(
  app: FastifyInstance,
  db: DB,
  live?: RelayLive,
  config?: Config,
): void {
  const identity = db.ensureRelayIdentity(generateRelayIdentity);
  const relayFp = fingerprintB64url(Buffer.from(identity.pubkey, 'base64'));

  /** Resolve a bearer token to a live, non-revoked device id (or null). */
  function deviceIdForToken(token: string | null): string | null {
    const deviceId = token ? verifyDeviceToken(token) : null;
    const device = deviceId ? db.getRelayDeviceById(deviceId) : undefined;
    return device && !device.revoked ? device.id : null;
  }

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

  // Live-delivery nudge socket (device-token authed). Optional so tests that
  // construct routes without the hub still work; when present, sends nudge the
  // recipient's connected devices to fetch immediately.
  if (live) {
    live.register(app, deviceIdForToken, config?.rateLimitMax ?? 600);
  }

  // Relay timestamps are non-decreasing within this process (D11 ordering).
  let lastTs = 0;
  function stampTs(): number {
    lastTs = Math.max(lastTs + 1, Date.now());
    return lastTs;
  }

  // Public: the pinned-identity handshake surface (UI-4 shows the name).
  // The full public key rides along so anyone can verify KT root signatures.
  app.get('/api/relay/info', async () => ({
    name: 'Accord relay',
    identityFingerprint: relayFp,
    identityPubKey: identity.pubkey,
    apiVersion: 1,
  }));

  // ---- key directory + transparency roots (D5) ----
  // Interim log shape: signed, hash-chained epoch roots over a digest of the
  // whole (sorted) directory. Append-only + consistency-checkable; per-entry
  // inclusion proofs and VRF-blinded labels (full AKD lineage) land before
  // the published KT spec is declared final — see key-transparency.md.

  const signingKey = createPrivateKey({
    key: Buffer.from(identity.privkey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  function publishEpoch(): number {
    const digest = createHash('sha256');
    for (const e of db.allRelayDirectoryEntries()) {
      digest.update(`${e.handle}|${e.identityPubkey}|${e.sealingPubkey}\n`);
    }
    const rootHash = digest.digest('base64url');
    const prev = db.latestKtRoot();
    if (prev && prev.rootHash === rootHash) return prev.epoch; // no change, no epoch
    const payload = `kt-root|${rootHash}|${prev?.rootHash ?? 'genesis'}`;
    const signature = edSign(null, Buffer.from(payload), signingKey).toString('base64');
    return db.appendKtRoot(rootHash, prev?.rootHash ?? null, signature);
  }

  // Register this account's per-relay public keys (device-token authed).
  app.put('/api/relay/directory', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const b = request.body as { identityPubKey?: string; sealingPubKey?: string } | null;
    if (!b?.identityPubKey || !b?.sealingPubKey || !rawKey(b.identityPubKey) || !rawKey(b.sealingPubKey)) {
      return reply.code(400).send({ error: 'identityPubKey and sealingPubKey (base64, 32 bytes) required' });
    }
    db.setRelayDirectoryEntry(device.userId, b.identityPubKey, b.sealingPubKey);
    return { epoch: publishEpoch() };
  });

  app.get('/api/relay/directory/:handle', async (request, reply) => {
    const { handle } = request.params as { handle: string };
    const entry = db.getRelayDirectoryByHandle(handle);
    if (!entry) return reply.code(404).send({ error: 'unknown handle' });
    return {
      identityPubKey: entry.identityPubkey,
      sealingPubKey: entry.sealingPubkey,
      epoch: db.latestKtRoot()?.epoch ?? 0,
    };
  });

  const rootsHandler = async (request: FastifyRequest) => {
    const since = Number((request.query as { since?: string }).since ?? 0) || 0;
    return {
      relayFp,
      roots: db.listKtRoots(since).map((r) => ({
        epoch: r.epoch,
        rootHash: r.rootHash,
        prevRootHash: r.prevRootHash,
        signature: r.signature,
        timestamp: r.createdAt,
      })),
    };
  };
  app.get('/api/relay/kt/roots', rootsHandler);
  // Third-party auditor surface (key-transparency.md).
  app.get('/.well-known/accord/kt-roots', rootsHandler);

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
      // Nudge any connected recipient devices to fetch now (poll otherwise).
      live?.notifyDevices(devices);
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
      | { payload?: string; kdfParams?: unknown; passwordAuthHash?: string; recoveryAuthHash?: string }
      | null;
    if (!b?.payload || b.payload.length > 8192) {
      return reply.code(400).send({ error: 'payload required (max 8KB)' });
    }
    // KDF params (salt + Argon2 cost) are public and served pre-auth so a
    // cold-start device can derive its fetch auth key. Store them separately.
    const kdfParams = b.kdfParams ? JSON.stringify(b.kdfParams).slice(0, 512) : null;
    db.setRelayEscrow(
      device.userId,
      b.payload,
      kdfParams,
      b.passwordAuthHash ?? null,
      b.recoveryAuthHash ?? null,
    );
    return { ok: true };
  });

  // KDF params by handle — the pre-auth step that breaks the cold-start
  // chicken-and-egg (the fetch auth key needs the salt, which lives in the
  // escrow). Salt is not secret. Anti-enumeration: an escrow-less handle
  // gets a **deterministic pseudo-salt** (HMAC over the relay identity), so
  // a prober can't tell registered from unregistered. Rate-limited.
  app.post(
    '/api/relay/escrow/kdf',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const b = request.body as { handle?: string } | null;
      if (!b?.handle) return reply.code(400).send({ error: 'handle required' });
      const real = db.getRelayEscrowKdfByHandle(b.handle);
      if (real) return JSON.parse(real);
      // Deterministic per-handle pseudo-params: stable across probes, and the
      // subsequent fetch still returns a uniform 401 (real Argon2 cost so
      // timing matches). The salt is HMAC(relay privkey fingerprint, handle).
      const pseudoSalt = createHash('sha256')
        .update(`escrow-pseudo|${relayFp}|${b.handle.toLowerCase()}`)
        .digest();
      return { kdfSalt: [...pseudoSalt.subarray(0, 16)], kdfMKib: 19 * 1024, kdfT: 2, kdfP: 1 };
    },
  );

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
