import { describe, expect, it } from 'vitest';
import {
  INFO_NOTE_KEY,
  INFO_PRIVATE_KEY,
  generateKeyPair,
  generateMasterKey,
  hkdfBits,
  randomBytes,
  sealKey,
  sha256b64,
  unsealKey,
  unwrapKey,
  wrapKey,
} from '../../src/lib/crypto';
import { b64, ub64 } from '../../src/lib/b64';
import {
  deriveRecoveryAuthKey,
  generateRecoveryCode,
  parseRecoveryCode,
} from '../../src/lib/recovery';

/** Flip one ciphertext byte to simulate tampering (keeps it valid base64). */
function tamper(ctB64: string): string {
  const bytes = ub64(ctB64);
  bytes[0] ^= 0xff;
  return b64(bytes);
}

describe('base64 helpers', () => {
  it('round-trips arbitrary bytes including 0x00 and 0xff', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255, 254]);
    expect(ub64(b64(bytes))).toEqual(bytes);
  });
});

describe('wrapKey / unwrapKey', () => {
  it('round-trips a raw key with the same secret + info', async () => {
    const secret = randomBytes(32);
    const raw = randomBytes(32);
    const wrapped = await wrapKey(secret, raw, INFO_NOTE_KEY);
    expect(await unwrapKey(secret, wrapped, INFO_NOTE_KEY)).toEqual(raw);
  });

  it('uses a fresh random salt + iv each call', async () => {
    const secret = randomBytes(32);
    const raw = randomBytes(32);
    const a = await wrapKey(secret, raw, INFO_NOTE_KEY);
    const b = await wrapKey(secret, raw, INFO_NOTE_KEY);
    expect(a.salt).not.toEqual(b.salt);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ct).not.toEqual(b.ct);
  });

  it('rejects the wrong secret', async () => {
    const raw = randomBytes(32);
    const wrapped = await wrapKey(randomBytes(32), raw, INFO_NOTE_KEY);
    await expect(unwrapKey(randomBytes(32), wrapped, INFO_NOTE_KEY)).rejects.toThrow();
  });

  it('rejects the wrong info (domain separation)', async () => {
    const secret = randomBytes(32);
    const wrapped = await wrapKey(secret, randomBytes(32), INFO_NOTE_KEY);
    await expect(unwrapKey(secret, wrapped, INFO_PRIVATE_KEY)).rejects.toThrow();
  });

  it('rejects tampered ciphertext (GCM auth)', async () => {
    const secret = randomBytes(32);
    const wrapped = await wrapKey(secret, randomBytes(32), INFO_NOTE_KEY);
    await expect(
      unwrapKey(secret, { ...wrapped, ct: tamper(wrapped.ct) }, INFO_NOTE_KEY),
    ).rejects.toThrow();
  });
});

describe('hkdfBits', () => {
  it('is deterministic for identical inputs', async () => {
    const secret = randomBytes(32);
    const salt = randomBytes(16);
    const a = await hkdfBits(secret, salt, 'notes:test:v1');
    const b = await hkdfBits(secret, salt, 'notes:test:v1');
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
  });

  it('separates domains: different info → different keys', async () => {
    const secret = randomBytes(32);
    const salt = randomBytes(16);
    const a = await hkdfBits(secret, salt, 'notes:test:a');
    const b = await hkdfBits(secret, salt, 'notes:test:b');
    expect(a).not.toEqual(b);
  });

  it('different salt → different keys', async () => {
    const secret = randomBytes(32);
    const a = await hkdfBits(secret, randomBytes(16), 'notes:test:v1');
    const b = await hkdfBits(secret, randomBytes(16), 'notes:test:v1');
    expect(a).not.toEqual(b);
  });

  it('honours the requested byte length', async () => {
    const out = await hkdfBits(randomBytes(32), randomBytes(16), 'x', 16);
    expect(out.length).toBe(16);
  });
});

describe('sealKey / unsealKey (X25519 sealed box)', () => {
  it('round-trips to the intended recipient', async () => {
    const recipient = generateKeyPair();
    const raw = randomBytes(32);
    const sealed = await sealKey(recipient.publicKey, raw);
    expect(await unsealKey(recipient.privateKey, recipient.publicKey, sealed)).toEqual(raw);
  });

  it('cannot be unsealed by a different keypair', async () => {
    const recipient = generateKeyPair();
    const attacker = generateKeyPair();
    const sealed = await sealKey(recipient.publicKey, randomBytes(32));
    await expect(
      unsealKey(attacker.privateKey, attacker.publicKey, sealed),
    ).rejects.toThrow();
  });

  it('rejects tampered sealed ciphertext', async () => {
    const recipient = generateKeyPair();
    const sealed = await sealKey(recipient.publicKey, randomBytes(32));
    await expect(
      unsealKey(recipient.privateKey, recipient.publicKey, { ...sealed, ct: tamper(sealed.ct) }),
    ).rejects.toThrow();
  });
});

describe('generateKeyPair', () => {
  it('produces 32-byte X25519 public + private keys', () => {
    const { publicKey, privateKey } = generateKeyPair();
    expect(publicKey.length).toBe(32);
    expect(privateKey.length).toBe(32);
  });

  it('produces unique keypairs', () => {
    expect(b64(generateKeyPair().publicKey)).not.toBe(b64(generateKeyPair().publicKey));
  });
});

describe('generateMasterKey', () => {
  it('is 32 random bytes', () => {
    expect(generateMasterKey().length).toBe(32);
    expect(b64(generateMasterKey())).not.toBe(b64(generateMasterKey()));
  });
});

describe('sha256b64', () => {
  it('matches the known SHA-256 of an empty input', async () => {
    // SHA-256("") = e3b0c442... → base64 below.
    expect(await sha256b64(new Uint8Array())).toBe('47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  });

  it('is stable for identical input and differs for different input', async () => {
    const data = new TextEncoder().encode('hello');
    expect(await sha256b64(data)).toBe(await sha256b64(data));
    expect(await sha256b64(data)).not.toBe(await sha256b64(new TextEncoder().encode('world')));
  });
});

describe('recovery codes', () => {
  it('formats as 8 groups of 4 base32 chars', () => {
    const { code } = generateRecoveryCode();
    expect(code).toMatch(/^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  });

  it('parse(format) recovers the original 20-byte secret', () => {
    const { code, secret } = generateRecoveryCode();
    expect(parseRecoveryCode(code)).toEqual(secret);
  });

  it('parsing is case-insensitive and ignores separators/spaces', () => {
    const { code, secret } = generateRecoveryCode();
    expect(parseRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toEqual(secret);
  });

  it('rejects a wrong-length code', () => {
    expect(() => parseRecoveryCode('ABCD')).toThrow();
  });

  it('derives a stable auth key independent of the wrap path', async () => {
    const { secret } = generateRecoveryCode();
    const a = await deriveRecoveryAuthKey(secret);
    const b = await deriveRecoveryAuthKey(secret);
    expect(a).toEqual(b);
    expect(a.length).toBe(32);
    // Different secret → different auth key.
    const other = await deriveRecoveryAuthKey(generateRecoveryCode().secret);
    expect(a).not.toEqual(other);
  });
});
