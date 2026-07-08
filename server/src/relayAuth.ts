// v8 relay device auth (spec/relay.md, roadmap D4/D4b).
//
// Devices authenticate by signing `${nonce}|${relayIdentityFingerprint}` with
// their Ed25519 device key (the fingerprint binding prevents a malicious
// relay replaying the signature to a different relay). The relay answers with
// a short-lived HMAC bearer token — stateless on purpose: the signing secret
// is per-boot, so a restart just forces a silent re-auth, and revoking a
// device works by refusing its *next* challenge (D4: no server blocklist).

import {
  createHmac,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
  verify as edVerify,
  createHash,
  type KeyObject,
} from 'node:crypto';

export const DEVICE_TOKEN_TTL_SEC = 900;

// DER prefix for a raw Ed25519 public key wrapped as SPKI.
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const bootSecret = randomBytes(32);

export function ed25519PublicKey(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('bad ed25519 public key length');
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function verifyDeviceSignature(rawPubkey: Buffer, payload: string, signature: Buffer): boolean {
  try {
    return edVerify(null, Buffer.from(payload), ed25519PublicKey(rawPubkey), signature);
  } catch {
    return false;
  }
}

/** b64url(SHA-256(raw pubkey)) — used as both the relay fingerprint and
 *  device ids, so ids are stable and content-derived. */
export function fingerprintB64url(rawPubkey: Buffer): string {
  return createHash('sha256').update(rawPubkey).digest('base64url');
}

/** Fresh relay identity for first boot; stored durably by the DB layer. */
export function generateRelayIdentity(): { pubkey: string; privkey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    pubkey: spki.subarray(spki.length - 32).toString('base64'),
    privkey: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
  };
}

export function issueDeviceToken(
  deviceId: string,
  now = Date.now(),
): { token: string; expiresInSec: number } {
  const exp = Math.floor(now / 1000) + DEVICE_TOKEN_TTL_SEC;
  const base = `v1.${deviceId}.${exp}`;
  const mac = createHmac('sha256', bootSecret).update(base).digest('base64url');
  return { token: `${base}.${mac}`, expiresInSec: DEVICE_TOKEN_TTL_SEC };
}

/** Returns the device id for a valid, unexpired token; null otherwise. */
export function verifyDeviceToken(token: string, now = Date.now()): string | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, deviceId, expStr, mac] = parts;
  const base = `v1.${deviceId}.${expStr}`;
  const expected = createHmac('sha256', bootSecret).update(base).digest('base64url');
  const a = Buffer.from(mac ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 <= now) return null;
  return deviceId ?? null;
}
