import { hkdfBits } from './crypto';

// RFC 4648 base32 alphabet; codes are case-insensitive on input.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SECRET_BYTES = 20; // 160 bits -> 32 base32 chars -> 8 groups of 4

const te = new TextEncoder();

function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Defensive: codes are always 20 bytes (160 bits, a multiple of 5), so the
  // public API never leaves a remainder here.
  /* v8 ignore start */
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  /* v8 ignore stop */
  return out;
}

function fromBase32(s: string): Uint8Array {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    // Defensive: parseRecoveryCode() pre-filters to the base32 alphabet, so a
    // stray character never reaches here via the public API.
    /* v8 ignore start */
    if (idx === -1) throw new Error('invalid recovery code');
    /* v8 ignore stop */
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export interface RecoveryCode {
  /** formatted for display, e.g. ABCD-EFGH-... */
  code: string;
  secret: Uint8Array;
}

export function generateRecoveryCode(): RecoveryCode {
  const secret = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(secret);
  const raw = toBase32(secret);
  const code = raw.match(/.{1,4}/g)!.join('-');
  return { code, secret };
}

export function parseRecoveryCode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const secret = fromBase32(cleaned);
  if (secret.length !== SECRET_BYTES) throw new Error('recovery code has the wrong length');
  return secret;
}

/** Key sent to the server to authenticate recovery (server stores its hash).
 * Independent of the wrap key, so the server never learns anything that can
 * decrypt the master key. */
export function deriveRecoveryAuthKey(secret: Uint8Array): Promise<Uint8Array> {
  return hkdfBits(secret, te.encode('notes:recovery:auth-salt:v1'), 'notes:recovery:auth:v1');
}
