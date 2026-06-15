import { describe, expect, it } from 'vitest';
import { generateKeyPair, generateMasterKey } from '../../src/lib/crypto';
import {
  decryptProfile,
  encryptProfile,
  generateProfileKey,
  sealProfileKey,
  unsealProfileKey,
  unwrapProfileKey,
  wrapProfileKey,
} from '../../src/lib/profileCrypto';
import { b64, ub64 } from '../../src/lib/b64';

describe('profile crypto', () => {
  it('encrypts and decrypts a profile blob round-trip', async () => {
    const key = generateProfileKey();
    const data = { bio: 'hi there 👋', avatar: 'data:image/webp;base64,AAAA' };
    const { ciphertext, iv } = await encryptProfile(key, data);
    expect(await decryptProfile(key, ciphertext, iv)).toEqual(data);
  });

  it('uses a fresh IV per encryption', async () => {
    const key = generateProfileKey();
    const a = await encryptProfile(key, { bio: 'x' });
    const b = await encryptProfile(key, { bio: 'x' });
    expect(a.iv).not.toBe(b.iv);
  });

  it('fails to decrypt under the wrong profile key', async () => {
    const { ciphertext, iv } = await encryptProfile(generateProfileKey(), { bio: 'secret' });
    await expect(decryptProfile(generateProfileKey(), ciphertext, iv)).rejects.toThrow();
  });

  it('wraps the profile key under the master key and recovers it', async () => {
    const mk = generateMasterKey();
    const profileKey = generateProfileKey();
    const wrapped = await wrapProfileKey(mk, profileKey);
    expect(await unwrapProfileKey(mk, wrapped)).toEqual(profileKey);
  });

  it('does not unwrap the profile key under a different master key', async () => {
    const wrapped = await wrapProfileKey(generateMasterKey(), generateProfileKey());
    await expect(unwrapProfileKey(generateMasterKey(), wrapped)).rejects.toThrow();
  });

  it('seals the profile key to a contact who unseals it; a stranger cannot', async () => {
    const profileKey = generateProfileKey();
    const contact = generateKeyPair();
    const stranger = generateKeyPair();
    const sealed = await sealProfileKey(contact.publicKey, profileKey);

    expect(await unsealProfileKey(contact.privateKey, contact.publicKey, sealed)).toEqual(profileKey);
    await expect(
      unsealProfileKey(stranger.privateKey, stranger.publicKey, sealed),
    ).rejects.toThrow();
  });

  it('end-to-end: a contact unseals the key and decrypts the blob', async () => {
    const profileKey = generateProfileKey();
    const contact = generateKeyPair();
    const { ciphertext, iv } = await encryptProfile(profileKey, { bio: 'full bio', avatar: 'data:image/webp;base64,ZZZZ' });
    const sealed = await sealProfileKey(contact.publicKey, profileKey);

    const recovered = await unsealProfileKey(contact.privateKey, contact.publicKey, sealed);
    expect(await decryptProfile(recovered, ciphertext, iv)).toEqual({
      bio: 'full bio',
      avatar: 'data:image/webp;base64,ZZZZ',
    });
  });

  it('rotation: an old sealed key cannot decrypt a blob re-encrypted under a new key', async () => {
    const oldKey = generateProfileKey();
    const contact = generateKeyPair();
    const oldSealed = await sealProfileKey(contact.publicKey, oldKey);

    // Rotate: new key, re-encrypt, and (in practice) re-seal only to remaining
    // contacts. A revoked contact still holds oldSealed → oldKey, which no longer
    // matches the new ciphertext.
    const newKey = generateProfileKey();
    const { ciphertext, iv } = await encryptProfile(newKey, { bio: 'updated' });

    const oldRecovered = await unsealProfileKey(contact.privateKey, contact.publicKey, oldSealed);
    expect(b64(oldRecovered)).not.toBe(b64(newKey));
    await expect(decryptProfile(oldRecovered, ciphertext, iv)).rejects.toThrow();
  });

  it('avatar bytes survive the blob round-trip unchanged', async () => {
    const key = generateProfileKey();
    const avatar = `data:image/webp;base64,${b64(new Uint8Array([0, 255, 1, 254, 128]))}`;
    const { ciphertext, iv } = await encryptProfile(key, { avatar });
    const out = await decryptProfile(key, ciphertext, iv);
    expect(out.avatar).toBe(avatar);
    expect(ub64(out.avatar!.split(',')[1]!)).toEqual(new Uint8Array([0, 255, 1, 254, 128]));
  });
});
