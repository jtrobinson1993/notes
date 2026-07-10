// v8 relay surface, phase 3 (spec/relay.md): relay info, device enrollment
// (via the legacy session — the migration bootstrap path), and the
// challenge → signed-nonce → short-lived-token auth flow (D4/D4b).

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, createPrivateKey, randomBytes, sign as edSign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { RelayLive } from '../relayLive.js';
import type { VoiceSignal } from '../voiceSignal.js';
import type { VoiceSfu } from '../voiceSfu.js';
import type { KtSidecar } from '../ktSidecar.js';
import type { Push } from '../push.js';
import { requireAuth } from '../session.js';
import { newToken } from '../util.js';
import { directoryRoot, inclusionProof, leafHash } from '../ktMerkle.js';
import {
  fingerprintB64url,
  generateRelayIdentity,
  issueDeviceToken,
  verifyDeviceSignature,
  verifyDeviceToken,
} from '../relayAuth.js';

/** Owner/admin identity pubkeys from a parsed group record — the set whose
 *  signature the relay accepts for an update (D14). */
function groupAdminPubkeys(rec: unknown): string[] {
  const members = (rec as { members?: unknown })?.members;
  if (!Array.isArray(members)) return [];
  return members
    .filter(
      (m): m is { identityPubKey: string; role: string } =>
        !!m &&
        typeof (m as { identityPubKey?: unknown }).identityPubKey === 'string' &&
        ((m as { role?: unknown }).role === 'owner' || (m as { role?: unknown }).role === 'admin'),
    )
    .map((m) => m.identityPubKey);
}

/** True if `signature` over `record` verifies against any of `pubkeys`
 *  (base64 raw Ed25519). Malformed keys/sigs simply don't match. */
function signedByAny(pubkeys: string[], record: string, signature: Buffer): boolean {
  return pubkeys.some((pk) => {
    try {
      return verifyDeviceSignature(Buffer.from(pk, 'base64'), record, signature);
    } catch {
      return false;
    }
  });
}

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
  voiceSignal?: VoiceSignal,
  voiceSfu?: VoiceSfu,
  ktSidecar?: KtSidecar,
  push?: Push,
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

  // v8 voice signaling socket (device-token authed; call-id-scoped frame relay).
  if (voiceSignal) {
    voiceSignal.register(app, deviceIdForToken, config?.rateLimitMax ?? 600);
  }

  // v8 voice SFU (device-token + call-id capability; mediasoup media rooms).
  if (voiceSfu) {
    voiceSfu.register(app, deviceIdForToken, config?.rateLimitMax ?? 600);
  }

  /** Current member identity pubkeys of a group, from its signed state record
   *  (D14). Empty if the group is unknown or the record can't be parsed. */
  function groupMemberPubkeys(groupId: string): string[] {
    const cur = db.getRelayGroupState(groupId);
    if (!cur) return [];
    try {
      const members = (JSON.parse(cur.record) as { members?: unknown }).members;
      if (!Array.isArray(members)) return [];
      return members
        .map((m) => (m as { identityPubKey?: unknown })?.identityPubKey)
        .filter((k): k is string => typeof k === 'string');
    } catch {
      return [];
    }
  }
  /** The requester's per-relay directory identity key (undefined if unpublished). */
  function requesterIdentity(userId: string): string | undefined {
    return db.getRelayDirectoryByUserId(userId)?.identityPubkey;
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

  /** Sign + chain a new root hash into the relay's KT log (both KT backends
   *  publish signed, hash-chained roots; only the *root value* + proof shape
   *  differ). Returns the relay epoch (or the prior one if unchanged). */
  function appendSignedRoot(rootHash: string): number {
    const prev = db.latestKtRoot();
    if (prev && prev.rootHash === rootHash) return prev.epoch; // no change, no epoch
    const payload = `kt-root|${rootHash}|${prev?.rootHash ?? 'genesis'}`;
    const signature = edSign(null, Buffer.from(payload), signingKey).toString('base64');
    return db.appendKtRoot(rootHash, prev?.rootHash ?? null, signature);
  }

  function publishEpoch(): number {
    // Interim Merkle root over the handle-ordered directory — the same ordering
    // the per-entry inclusion proofs are built against (see ktMerkle).
    return appendSignedRoot(directoryRoot(db.allRelayDirectoryEntries()));
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
    if (ktSidecar) {
      // Full-AKD: publish this handle→identity-key binding to the sidecar as a
      // new epoch, then sign + chain the akd root into the relay's KT log.
      const handle = db.getUser(device.userId)?.handle;
      if (!handle) return reply.code(409).send({ error: 'no handle for account' });
      const { root } = await ktSidecar.publish([{ handle, key: b.identityPubKey }]);
      return { epoch: appendSignedRoot(root) };
    }
    return { epoch: publishEpoch() };
  });

  app.get('/api/relay/directory/:handle', async (request, reply) => {
    const { handle } = request.params as { handle: string };
    if (ktSidecar) {
      // Full-AKD: the identity/sealing keys come from the relay directory, the
      // VRF-blinded inclusion proof + root + VRF key from the sidecar. The client
      // runs akd lookup_verify(proof) against `root` (whose signature it checks
      // via /kt/roots).
      const entry = db.getRelayDirectoryByHandle(handle);
      if (!entry) return reply.code(404).send({ error: 'unknown handle' });
      const look = await ktSidecar.lookup(handle);
      if (!look) return reply.code(404).send({ error: 'unknown handle' });
      return {
        identityPubKey: entry.identityPubkey,
        sealingPubKey: entry.sealingPubkey,
        epoch: look.epoch,
        rootHash: look.root,
        proof: look.proof,
        vrfPublicKey: await ktSidecar.vrfPublicKey(),
        kt: 'akd',
      };
    }
    // Build the proof from the same handle-ordered set the root is computed
    // over, so the returned key is provably present under the signed epoch root
    // (spec/key-transparency.md — inclusion/lookup proof on every fetch). The
    // client verifies proof → rootHash and rootHash's signature via /kt/roots.
    const entries = db.allRelayDirectoryEntries();
    const index = entries.findIndex((e) => e.handle.toLowerCase() === handle.toLowerCase());
    const entry = index < 0 ? undefined : entries[index];
    if (!entry) return reply.code(404).send({ error: 'unknown handle' });
    const root = db.latestKtRoot();
    return {
      identityPubKey: entry.identityPubkey,
      sealingPubKey: entry.sealingPubkey,
      epoch: root?.epoch ?? 0,
      rootHash: root?.rootHash ?? directoryRoot(entries),
      proof: inclusionProof(entries.map(leafHash), index),
    };
  });

  // Key-history proof for self-audit (D5): only the full-AKD backend can prove a
  // handle's key history; the interim Merkle KT has none (→ 404).
  app.get('/api/relay/directory/:handle/history', async (request, reply) => {
    const { handle } = request.params as { handle: string };
    if (!ktSidecar) return reply.code(404).send({ error: 'no key history (interim KT)' });
    const hist = await ktSidecar.keyHistory(handle);
    if (!hist) return reply.code(404).send({ error: 'unknown handle' });
    return {
      epoch: hist.epoch,
      rootHash: hist.root,
      proof: hist.proof,
      vrfPublicKey: await ktSidecar.vrfPublicKey(),
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
      // Offline recipient (no live device): a content-free push wakes a device
      // to drain the sealed mailbox (D7). Online devices already got the nudge.
      const anyOnline = devices.some((d) => live?.isDeviceOnline(d));
      if (!anyOnline) push?.notifyMailbox(user.id);
    }
    db.pruneRelayMailbox(MAILBOX_TTL_MS); // opportunistic TTL sweep
    return { relayTs };
  });

  // ---- content-free push registration (D7) ----
  // The VAPID public key a client needs to create a web-push subscription
  // (null when push isn't configured → the client falls back to poll/live-WS).
  app.get('/api/relay/push/key', async () => ({ publicKey: push?.publicKey ?? null }));

  // Register a web-push subscription for the device's account (device-token
  // authed). The push only ever carries `{type:'mail'}`, so this leaks nothing.
  app.post('/api/relay/push/subscribe', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const b = request.body as { endpoint?: string; p256dh?: string; auth?: string } | null;
    if (!b?.endpoint || !b?.p256dh || !b?.auth) {
      return reply.code(400).send({ error: 'endpoint, p256dh, auth required' });
    }
    db.addPushSubscription({ userId: device.userId, endpoint: b.endpoint, p256dh: b.p256dh, auth: b.auth });
    return { ok: true };
  });

  app.post('/api/relay/push/unsubscribe', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const b = request.body as { endpoint?: string } | null;
    if (!b?.endpoint) return reply.code(400).send({ error: 'endpoint required' });
    db.deletePushSubscription(device.userId, b.endpoint);
    return { ok: true };
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

  // ---- friend invites (D4b) ----
  // The invite token is a one-time delivery capability: redeeming it drops
  // exactly one sealed "friend-accept" envelope (carrying the invitee's own
  // delivery token, sealed E2E to the inviter) into the inviter's mailbox;
  // reciprocation is then an ordinary sealed send. The relay stores only
  // hash(token) — the token itself is shared out-of-band (QR / link) and never
  // seen here. Redeem is deliberately NOT device-authenticated: requiring the
  // invitee's device token would let the relay link "X redeemed Y's invite" =
  // a social-graph edge, defeating sealed-sender (D6).

  const INVITE_MAX_TTL_MS = 14 * 24 * 60 * 60_000;
  const INVITE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;

  // Mint (device token): store hash(token) + expiry for one of the caller's
  // own future friends.
  app.post('/api/relay/invites', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const b = request.body as { tokenHash?: string; expiresInSec?: number } | null;
    if (!b?.tokenHash || typeof b.tokenHash !== 'string' || b.tokenHash.length > 128) {
      return reply.code(400).send({ error: 'tokenHash required' });
    }
    const ttlMs =
      typeof b.expiresInSec === 'number' && b.expiresInSec > 0
        ? Math.min(b.expiresInSec * 1000, INVITE_MAX_TTL_MS)
        : INVITE_DEFAULT_TTL_MS;
    const expiresAt = Date.now() + ttlMs;
    db.mintRelayInvite(b.tokenHash, device.userId, expiresAt);
    return { expiresAt };
  });

  // Redeem (capability only — no device token). Uniform 401 for
  // unknown/expired/used so a probe can't tell them apart (the token is
  // high-entropy, so this leaks nothing about real accounts).
  app.post('/api/relay/invites/redeem', async (request, reply) => {
    const b = request.body as { token?: string; envelope?: string } | null;
    if (!b?.token || !b?.envelope) {
      return reply.code(400).send({ error: 'token and envelope required' });
    }
    if (b.envelope.length > MAX_ENVELOPE_B64) {
      return reply.code(413).send({ error: 'envelope too large' });
    }
    const tokenHash = createHash('sha256').update(b.token).digest('base64url');
    const inviterUserId = db.redeemRelayInvite(tokenHash, Date.now());
    if (!inviterUserId) return reply.code(401).send({ error: 'invite invalid' });
    const devices = db.activeRelayDeviceIds(inviterUserId);
    const relayTs = stampTs();
    if (devices.length) {
      db.enqueueRelayEnvelope(devices, relayTs, Buffer.from(b.envelope, 'base64'));
      live?.notifyDevices(devices);
    }
    db.pruneRelayInvites(MAILBOX_TTL_MS); // opportunistic sweep
    return { relayTs };
  });

  // Non-consuming validity check (rate-limited: cheap oracle guard even though
  // tokens are unguessable).
  app.post(
    '/api/relay/invites/check',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const b = request.body as { token?: string } | null;
      if (!b?.token) return reply.code(400).send({ error: 'token required' });
      const tokenHash = createHash('sha256').update(b.token).digest('base64url');
      const invite = db.getRelayInvite(tokenHash);
      const valid = !!invite && !invite.used && invite.expiresAt >= Date.now();
      return { valid };
    },
  );

  // ---- transient blob store (D6) ----
  // Attachment ciphertext travels through the relay. Upload is authorized by
  // the recipient's DELIVERY TOKEN (sealed-sender-compatible — the uploader
  // proves it may send to the recipient but stays sender-anonymous, exactly
  // like mailbox/send); download is DEVICE-TOKEN gated to that recipient plus
  // the unguessable 256-bit blobId (capability). The per-file key + which
  // message the blob belongs to ride inside the E2E envelope and never reach
  // the relay. First cut is DM-scoped: group blobs (one blob, many recipients,
  // GC on all-ack) wait on the group-state record (D14) for the member set.
  if (config) {
    const blobDir = join(config.dataDir, 'relay-blobs');
    const BLOB_TTL_MS = 14 * 24 * 60 * 60_000; // D6
    const MAX_BLOB_BYTES = 32 * 1024 * 1024;
    const BLOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

    // Contain the id to blobDir (the allowlist already forbids separators; this
    // is defense-in-depth + the explicit barrier CodeQL path-injection needs).
    const blobPathFor = (id: string): string | null => {
      if (!BLOB_ID_RE.test(id)) return null;
      const root = resolve(blobDir);
      const path = resolve(root, id);
      return path === join(root, id) && path.startsWith(root + sep) ? path : null;
    };

    // Reuse the octet-stream buffer parser (attachments may already register
    // it; register only if absent so route order can't cause a double-add).
    if (!app.hasContentTypeParser('application/octet-stream')) {
      app.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer', bodyLimit: MAX_BLOB_BYTES },
        (_req, body, done) => done(null, body),
      );
    }

    const blobRate = { rateLimit: { max: config.rateLimitMax, timeWindow: '1 minute' } };

    // Serve a blob file with optional HTTP Range support — resumable / ranged
    // transfer for large media (D6 follow-up; first cut had been whole-blob
    // only). A download interrupted at byte N is resumed with `Range: bytes=N-`,
    // which we answer with 206 + the remaining bytes; a malformed or
    // unsatisfiable range gets 416. The relay only ever holds ciphertext, so
    // range serving leaks nothing beyond the already-known blob size.
    const sendBlobFile = async (
      reply: FastifyReply,
      path: string,
      rangeHeader: string | string[] | undefined,
    ): Promise<unknown> => {
      const { size } = await stat(path);
      reply.header('content-type', 'application/octet-stream');
      reply.header('accept-ranges', 'bytes');
      reply.header('cache-control', 'private, max-age=31536000, immutable');

      const raw = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader;
      if (!raw) {
        reply.header('content-length', size);
        return reply.send(createReadStream(path));
      }
      const unsatisfiable = (): unknown => {
        reply.header('content-type', 'application/json; charset=utf-8');
        reply.header('content-range', `bytes */${size}`);
        return reply.code(416).send({ error: 'range not satisfiable' });
      };
      // Single range only: "bytes=start-end", "bytes=start-", or "bytes=-suffix".
      const m = /^bytes=(\d*)-(\d*)$/.exec(raw.trim());
      if (!m) return unsatisfiable();
      const [, startStr, endStr] = m;
      let start: number;
      let end: number;
      if (startStr === '' && endStr === '') return unsatisfiable();
      if (startStr === '') {
        const n = Number(endStr); // suffix: last N bytes
        if (n === 0) return unsatisfiable();
        start = Math.max(0, size - n);
        end = size - 1;
      } else {
        start = Number(startStr);
        end = endStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
      }
      if (start > end || start >= size) return unsatisfiable();
      reply.code(206);
      reply.header('content-range', `bytes ${start}-${end}/${size}`);
      reply.header('content-length', end - start + 1);
      return reply.send(createReadStream(path, { start, end }));
    };

    // Upload (delivery-token capability, NOT device-authed). Credentials ride
    // in headers since the body is the raw ciphertext. Uniform 401 for a bad
    // handle/token (no enumeration), matching mailbox/send.
    app.post(
      '/api/relay/blobs',
      { bodyLimit: MAX_BLOB_BYTES, config: blobRate },
      async (request, reply) => {
        const deliveryToken = request.headers['x-delivery-token'];
        const recipientHandle = request.headers['x-recipient-handle'];
        if (typeof deliveryToken !== 'string' || typeof recipientHandle !== 'string') {
          return reply.code(400).send({ error: 'x-delivery-token and x-recipient-handle required' });
        }
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return reply.code(400).send({ error: 'expected application/octet-stream body' });
        }
        const user = db.getUserByHandle(recipientHandle);
        const verifier = user ? db.getRelayVerifier(user.id) : undefined;
        const presented = createHash('sha256').update(deliveryToken).digest('base64url');
        if (!user || !verifier || presented !== verifier) {
          return reply.code(401).send({ error: 'upload refused' });
        }
        const blobId = newToken();
        await mkdir(blobDir, { recursive: true });
        await writeFile(join(blobDir, blobId), body);
        db.createRelayBlob(blobId, user.id, body.length);
        for (const id of db.pruneRelayBlobs(BLOB_TTL_MS)) {
          await unlink(join(blobDir, id)).catch(() => {});
        }
        return { blobId, size: body.length };
      },
    );

    // Download (device token; only the intended recipient's devices). Unknown
    // or not-yours id → uniform 404.
    app.get('/api/relay/blobs/:id', { config: blobRate }, async (request, reply) => {
      const device = requireDevice(request, reply);
      if (!device) return;
      const { id } = request.params as { id: string };
      const path = blobPathFor(id);
      const blob = path ? db.getRelayBlob(id) : undefined;
      if (!path || !blob || blob.recipientUserId !== device.userId) {
        return reply.code(404).send({ error: 'not found' });
      }
      try {
        return await sendBlobFile(reply, path, request.headers.range);
      } catch {
        return reply.code(404).send({ error: 'not found' });
      }
    });

    // Per-recipient ack → delete (DM: one recipient, so ack = done).
    app.post('/api/relay/blobs/:id/ack', { config: blobRate }, async (request, reply) => {
      const device = requireDevice(request, reply);
      if (!device) return;
      const { id } = request.params as { id: string };
      const path = blobPathFor(id);
      const blob = path ? db.getRelayBlob(id) : undefined;
      if (!path || !blob || blob.recipientUserId !== device.userId) {
        return reply.code(404).send({ error: 'not found' });
      }
      db.deleteRelayBlob(id);
      await unlink(path).catch(() => {});
      return { ok: true };
    });

    // Group blob upload (D6/D14): authorized by the GROUP TOKEN (x-group-token),
    // so any member can upload sender-anonymously — the relay can't tell which
    // member (unlike a device token, which would leak the sender within the
    // group). Uniform 401 for a bad token.
    app.post(
      '/api/relay/groups/:id/blobs',
      { bodyLimit: MAX_BLOB_BYTES, config: blobRate },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const groupToken = request.headers['x-group-token'];
        if (typeof groupToken !== 'string') {
          return reply.code(400).send({ error: 'x-group-token required' });
        }
        const body = request.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return reply.code(400).send({ error: 'expected application/octet-stream body' });
        }
        const verifier = db.getRelayGroupVerifier(id);
        const presented = createHash('sha256').update(groupToken).digest('base64url');
        if (!verifier || presented !== verifier) {
          return reply.code(401).send({ error: 'upload refused' });
        }
        const blobId = newToken();
        await mkdir(blobDir, { recursive: true });
        await writeFile(join(blobDir, blobId), body);
        db.createRelayGroupBlob(blobId, id, body.length);
        for (const bid of db.pruneRelayGroupBlobs(BLOB_TTL_MS)) {
          await unlink(join(blobDir, bid)).catch(() => {});
        }
        return { blobId, size: body.length };
      },
    );

    // Group blob download: device token + current membership (per the group
    // state record). Unknown/wrong-group/non-member → uniform 404. First cut is
    // TTL-GC only; per-member-ack GC is a follow-up.
    app.get('/api/relay/groups/:id/blobs/:blobId', { config: blobRate }, async (request, reply) => {
      const device = requireDevice(request, reply);
      if (!device) return;
      const { id, blobId } = request.params as { id: string; blobId: string };
      const path = blobPathFor(blobId);
      const blob = path ? db.getRelayGroupBlob(blobId) : undefined;
      const me = requesterIdentity(device.userId);
      if (!path || !blob || blob.groupId !== id || !me || !groupMemberPubkeys(id).includes(me)) {
        return reply.code(404).send({ error: 'not found' });
      }
      try {
        return await sendBlobFile(reply, path, request.headers.range);
      } catch {
        return reply.code(404).send({ error: 'not found' });
      }
    });
  }

  // ---- group state (D14) ----
  // The group's authority record is a client-signed, opaque JSON string. The
  // relay does ordering + availability, NOT trust: it accepts a new version
  // only if (a) it is signed by a key the *current* record calls an owner/admin
  // (genesis is self-authorizing against its own admin set), and (b) its version
  // strictly exceeds the current one (anti-rollback). Clients independently
  // verify the full signature chain. Fine-grained role rules (e.g. only the
  // owner may remove admins) are client-enforced. groupIds must be unguessable
  // (a genesis for an unknown id just creates that group).
  const MAX_GROUP_RECORD = 64 * 1024;

  app.put('/api/relay/groups/:id/state', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const { id } = request.params as { id: string };
    const b = request.body as { record?: string; adminSignature?: string } | null;
    if (!b?.record || !b?.adminSignature || b.record.length > MAX_GROUP_RECORD) {
      return reply.code(400).send({ error: 'record and adminSignature required' });
    }
    let parsed: { groupId?: unknown; version?: unknown };
    try {
      parsed = JSON.parse(b.record);
    } catch {
      return reply.code(400).send({ error: 'record must be JSON' });
    }
    if (parsed.groupId !== id) {
      return reply.code(400).send({ error: 'record groupId mismatch' });
    }
    const version = parsed.version;
    if (!Number.isInteger(version)) {
      return reply.code(400).send({ error: 'record needs an integer version' });
    }
    const newAdmins = groupAdminPubkeys(parsed);
    if (!newAdmins.length) {
      return reply.code(400).send({ error: 'record needs an owner/admin' });
    }
    const sig = Buffer.from(b.adminSignature, 'base64');
    const current = db.getRelayGroupState(id);
    // Update: authorize against the CURRENT admins (so a member can't self-
    // escalate by naming themselves admin). Genesis: self-authorize.
    const authorizers = current
      ? groupAdminPubkeys(JSON.parse(current.record))
      : newAdmins;
    if (!signedByAny(authorizers, b.record, sig)) {
      return reply.code(403).send({ error: 'not signed by a current admin' });
    }
    if (current && (version as number) <= current.version) {
      return reply.code(409).send({ error: 'version not newer than current' });
    }
    db.putRelayGroupState(id, b.record, version as number);
    return { version };
  });

  app.get('/api/relay/groups/:id/state', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const { id } = request.params as { id: string };
    const current = db.getRelayGroupState(id);
    // Uniform 404 for missing OR not-a-member — non-members don't learn a group
    // exists. Membership = the requester's directory identity key is in members.
    if (!current) return reply.code(404).send({ error: 'not found' });
    const me = db.getRelayDirectoryByUserId(device.userId);
    let members: unknown[] = [];
    try {
      const m = (JSON.parse(current.record) as { members?: unknown }).members;
      if (Array.isArray(m)) members = m;
    } catch {
      /* stored record is always valid JSON (validated on PUT) */
    }
    const isMember =
      !!me &&
      members.some(
        (m) => (m as { identityPubKey?: unknown })?.identityPubKey === me.identityPubkey,
      );
    if (!isMember) return reply.code(404).send({ error: 'not found' });
    return { record: current.record, version: current.version };
  });

  // Group blob-upload verifier = hash(group token) shared among members. Any
  // current member may set it (they all derive the same value from the group
  // key); non-members can't touch it (403).
  app.put('/api/relay/groups/:id/verifier', async (request, reply) => {
    const device = requireDevice(request, reply);
    if (!device) return;
    const { id } = request.params as { id: string };
    const b = request.body as { verifier?: string } | null;
    if (!b?.verifier || typeof b.verifier !== 'string' || b.verifier.length > 128) {
      return reply.code(400).send({ error: 'verifier required' });
    }
    const me = requesterIdentity(device.userId);
    if (!me || !groupMemberPubkeys(id).includes(me)) {
      return reply.code(403).send({ error: 'not a group member' });
    }
    db.setRelayGroupVerifier(id, b.verifier);
    return { ok: true };
  });

  // Group send (D6/D14): one group-key-sealed envelope, authorized by the group
  // token (sender-anonymous like DM send), fanned out by the relay to every
  // current member's device queues per the signed group-state record. The relay
  // never decrypts — members share the group key.
  app.post('/api/relay/groups/:id/send', async (request, reply) => {
    const { id } = request.params as { id: string };
    const b = request.body as { groupToken?: string; envelope?: string } | null;
    if (!b?.groupToken || !b?.envelope) {
      return reply.code(400).send({ error: 'groupToken and envelope required' });
    }
    if (b.envelope.length > MAX_ENVELOPE_B64) {
      return reply.code(413).send({ error: 'envelope too large' });
    }
    const verifier = db.getRelayGroupVerifier(id);
    const presented = createHash('sha256').update(b.groupToken).digest('base64url');
    if (!verifier || presented !== verifier) {
      return reply.code(401).send({ error: 'send refused' });
    }
    // Fan out to every current member's devices (members are listed by identity
    // key in the D14 record → user → devices).
    const deviceIds = new Set<string>();
    for (const identityPub of groupMemberPubkeys(id)) {
      const userId = db.userIdByRelayIdentity(identityPub);
      if (userId) for (const d of db.activeRelayDeviceIds(userId)) deviceIds.add(d);
    }
    const relayTs = stampTs();
    const devices = [...deviceIds];
    if (devices.length) {
      db.enqueueRelayEnvelope(devices, relayTs, Buffer.from(b.envelope, 'base64'));
      live?.notifyDevices(devices);
    }
    db.pruneRelayMailbox(MAILBOX_TTL_MS);
    return { relayTs };
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
