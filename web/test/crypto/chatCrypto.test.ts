import { describe, expect, it } from 'vitest';
import type { MessagePayload } from '@notes/shared';
import {
  decryptMessage,
  encryptMessage,
  generateConversationKey,
  sealConversationKey,
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
});
