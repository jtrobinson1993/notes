import { argon2id } from 'hash-wasm';
import { hkdfBits } from './crypto';

// Optional password fallback for users without a working passkey. A password is
// low-entropy, so — unlike the high-entropy recovery code — it must go through a
// slow, memory-hard KDF (Argon2id) before it can wrap the master key, or a
// leaked `password_wrapped_mk` could be brute-forced offline. The Argon2id
// output is then used exactly like the recovery secret: it wraps a copy of MK
// and derives a separate server-auth key (see recovery.ts).

const te = new TextEncoder();

/** Enforced client-side only: the server never sees the password (zero-knowledge),
 *  so it can't check length. Long enough that Argon2id + rate limiting make both
 *  offline and online guessing infeasible. */
export const MIN_PASSWORD_LENGTH = 16;

// OWASP Argon2id baseline (m = 19 MiB, t = 2, p = 1). Memory-hard; tuned to stay
// usable in-browser on modest devices while resisting offline attack.
const ARGON2 = { parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32 } as const;

const SALT_BYTES = 16;

export function generatePasswordSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  return salt;
}

/** Slow, memory-hard derivation of a 32-byte key from the password + salt. */
export async function derivePasswordKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  return argon2id({ password, salt, ...ARGON2, outputType: 'binary' });
}

/** Key sent to the server to authenticate a password login (server stores its
 *  hash). Independent of the wrap key, so the server never learns anything that
 *  can decrypt the master key. */
export function derivePasswordAuthKey(passwordKey: Uint8Array): Promise<Uint8Array> {
  return hkdfBits(passwordKey, te.encode('notes:password:auth-salt:v1'), 'notes:password:auth:v1');
}
