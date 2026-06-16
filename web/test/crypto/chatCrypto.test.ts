import { describe, expect, it } from 'vitest';
import type { MessagePayload } from '@notes/shared';
import {
  decryptMessage,
  decryptReaction,
  encryptMessage,
  encryptReaction,
  generateConversationKey,
  sealConversationKey,
  sealConversationKeyToMembers,
  sealEpochKeysTo,
  unsealConversationKey,
} from '../../src/lib/chatCrypto';
import { generateKeyPair } from '../../src/lib/crypto';
import { b64, ub64 } from '../../src/lib/b64';

describe('conversation keys', () => {
  it('generates a 32-byte key', () => {
    expect(generateConversationKey().length).toBe(32);
  });

  it('seals to a member and unseals with their keypair', async () => {
    const member = generateKeyPair();
    const convKey = generateConversationKey();
    const sealed = await sealConversationKey(b64(member.publicKey), convKey);
    const out = await unsealConversationKey(sealed, member.privateKey, member.publicKey);
    expect(out).toEqual(convKey);
  });

  it('a key sealed to A cannot be unsealed by B', async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const sealed = await sealConversationKey(b64(a.publicKey), generateConversationKey());
    await expect(unsealConversationKey(sealed, b.privateKey, b.publicKey)).rejects.toThrow();
  });
});

describe('re-key helpers (membership changes)', () => {
  it('seals one key to many members, each unsealable by only that member', async () => {
    const m1 = generateKeyPair();
    const m2 = generateKeyPair();
    const convKey = generateConversationKey();
    const sealed = await sealConversationKeyToMembers(
      [{ userId: 'a', publicKey: b64(m1.publicKey) }, { userId: 'b', publicKey: b64(m2.publicKey) }],
      convKey,
    );
    expect(sealed.map((s) => s.userId)).toEqual(['a', 'b']);
    expect(await unsealConversationKey(sealed[0].sealedKey, m1.privateKey, m1.publicKey)).toEqual(convKey);
    expect(await unsealConversationKey(sealed[1].sealedKey, m2.privateKey, m2.publicKey)).toEqual(convKey);
    // a's copy isn't readable by b
    await expect(unsealConversationKey(sealed[0].sealedKey, m2.privateKey, m2.publicKey)).rejects.toThrow();
  });

  it('seals each prior epoch key to a joiner (share-history)', async () => {
    const joiner = generateKeyPair();
    const k0 = generateConversationKey();
    const k1 = generateConversationKey();
    const sealed = await sealEpochKeysTo(b64(joiner.publicKey), [{ epoch: 0, key: k0 }, { epoch: 1, key: k1 }]);
    expect(sealed.map((s) => s.epoch)).toEqual([0, 1]);
    expect(await unsealConversationKey(sealed[0].sealedKey, joiner.privateKey, joiner.publicKey)).toEqual(k0);
    expect(await unsealConversationKey(sealed[1].sealedKey, joiner.privateKey, joiner.publicKey)).toEqual(k1);
  });
});

describe('encryptMessage / decryptMessage', () => {
  const payload: MessagePayload = { text: 'hello **world** 🌍', sentAt: 1_700_000_000_000 };

  it('round-trips a MessagePayload', async () => {
    const convKey = generateConversationKey();
    const { ciphertext, iv } = await encryptMessage(convKey, payload);
    expect(await decryptMessage(convKey, ciphertext, iv)).toEqual(payload);
  });

  it('uses a fresh IV per message', async () => {
    const convKey = generateConversationKey();
    const a = await encryptMessage(convKey, payload);
    const b = await encryptMessage(convKey, payload);
    expect(a.iv).not.toEqual(b.iv);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('throws when decrypting with the wrong conversation key', async () => {
    const { ciphertext, iv } = await encryptMessage(generateConversationKey(), payload);
    await expect(decryptMessage(generateConversationKey(), ciphertext, iv)).rejects.toThrow();
  });

  it('throws on tampered ciphertext (GCM auth)', async () => {
    const convKey = generateConversationKey();
    const { ciphertext, iv } = await encryptMessage(convKey, payload);
    const bytes = ub64(ciphertext);
    bytes[0] ^= 0xff;
    await expect(decryptMessage(convKey, b64(bytes), iv)).rejects.toThrow();
  });

  it('round-trips a reaction emoji under the conversation key', async () => {
    const convKey = generateConversationKey();
    const { ciphertext, iv } = await encryptReaction(convKey, ':catJAM:');
    expect(await decryptReaction(convKey, ciphertext, iv)).toBe(':catJAM:');
    // wrong key fails (server can't read the emoji)
    await expect(decryptReaction(generateConversationKey(), ciphertext, iv)).rejects.toThrow();
  });
});
