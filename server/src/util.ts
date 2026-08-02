import { createHash, randomBytes } from 'node:crypto';

/** Max inbound WebSocket frame the relay will accept (`maxPayload` for
 * @fastify/websocket, applied to every socket: relayLive, voice signaling and
 * the SFU). Relay frames are small control/ciphertext envelopes — bulk content
 * goes through blob upload — so a 64 KiB ceiling caps how much memory a single
 * peer can make the server buffer per frame. */
export const WS_MAX_PAYLOAD = 64 * 1024;

export function newId(): string {
  return randomBytes(16).toString('base64url');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256b64(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('base64');
}

export function now(): number {
  return Date.now();
}

/** Validates the shape of a client-supplied WrappedKey. */
export function validWrappedKey(w: unknown): boolean {
  if (typeof w !== 'object' || w === null) return false;
  const o = w as Record<string, unknown>;
  return (
    typeof o.salt === 'string' &&
    typeof o.iv === 'string' &&
    typeof o.ct === 'string' &&
    o.salt.length < 256 &&
    o.iv.length < 256 &&
    o.ct.length < 1024
  );
}
