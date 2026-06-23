import { describe, expect, it } from 'vitest';
import {
  derivePasswordAuthKey,
  derivePasswordKey,
  generatePasswordSalt,
  MIN_PASSWORD_LENGTH,
} from '../../src/lib/password';
import { INFO_PASSWORD_WRAP, unwrapKey, wrapKey } from '../../src/lib/crypto';

const PW = 'correct horse battery staple!!';

describe('password fallback key derivation', () => {
  it('derives a stable 32-byte key for the same password + salt', async () => {
    const salt = generatePasswordSalt();
    const a = await derivePasswordKey(PW, salt);
    const b = await derivePasswordKey(PW, salt);
    expect(a).toHaveLength(32);
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
  });

  it('differs for a different salt and for a different password', async () => {
    const k1 = await derivePasswordKey(PW, generatePasswordSalt());
    const k2 = await derivePasswordKey(PW, generatePasswordSalt());
    expect(Buffer.from(k1)).not.toEqual(Buffer.from(k2)); // salt matters

    const salt = generatePasswordSalt();
    const k3 = await derivePasswordKey(PW, salt);
    const k4 = await derivePasswordKey('a different long passphrase!!', salt);
    expect(Buffer.from(k3)).not.toEqual(Buffer.from(k4)); // password matters
  });

  it('wraps and unwraps the master key', async () => {
    const passwordKey = await derivePasswordKey(PW, generatePasswordSalt());
    const mk = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await wrapKey(passwordKey, mk, INFO_PASSWORD_WRAP);
    const out = await unwrapKey(passwordKey, wrapped, INFO_PASSWORD_WRAP);
    expect(Buffer.from(out)).toEqual(Buffer.from(mk));
  });

  it('cannot unwrap MK with the wrong password', async () => {
    const salt = generatePasswordSalt();
    const mk = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await wrapKey(await derivePasswordKey(PW, salt), mk, INFO_PASSWORD_WRAP);
    const wrongKey = await derivePasswordKey('wrong passphrase, also long', salt);
    await expect(unwrapKey(wrongKey, wrapped, INFO_PASSWORD_WRAP)).rejects.toBeDefined();
  });

  it('derives a stable auth key independent of the wrap key', async () => {
    const passwordKey = await derivePasswordKey(PW, generatePasswordSalt());
    const auth1 = await derivePasswordAuthKey(passwordKey);
    const auth2 = await derivePasswordAuthKey(passwordKey);
    expect(Buffer.from(auth1)).toEqual(Buffer.from(auth2)); // stable
    expect(Buffer.from(auth1)).not.toEqual(Buffer.from(passwordKey)); // not the wrap key itself
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(16);
  });
});
