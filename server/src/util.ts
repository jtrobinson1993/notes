import { createHash, randomBytes } from 'node:crypto';

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

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
export function validUsername(u: unknown): u is string {
  return typeof u === 'string' && USERNAME_RE.test(u);
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
