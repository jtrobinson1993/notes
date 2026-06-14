import { describe, expect, it } from 'vitest';
import type { NotePayload, NoteRecord, SharedNoteRecord } from '@notes/shared';
import {
  decryptBlob,
  decryptNotePayload,
  decryptSharedNotePayload,
  encryptBlob,
  encryptNotePayload,
  encryptWithNoteKey,
  generateKeyPair,
  generateMasterKey,
  randomBytes,
  sealKey,
  unwrapNoteKey,
} from '../../src/lib/crypto';
import { b64, ub64 } from '../../src/lib/b64';

const payload: NotePayload = { title: 'Title', body: 'Body **bold**', tags: ['a', 'b'] };

describe('note payload encryption (encryptNotePayload / decryptNotePayload)', () => {
  it('round-trips a payload under the master key', async () => {
    const mk = generateMasterKey();
    const enc = await encryptNotePayload(mk, payload);
    const record: NoteRecord = {
      id: 'n1', ciphertext: enc.ciphertext, iv: enc.iv, wrappedKey: enc.wrappedKey,
      createdAt: 0, updatedAt: 0, deleted: false,
    };
    expect(await decryptNotePayload(mk, record)).toEqual(payload);
  });

  it('reuses an existing wrapped note key when re-encrypting (stable key)', async () => {
    const mk = generateMasterKey();
    const first = await encryptNotePayload(mk, payload);
    const second = await encryptNotePayload(mk, { ...payload, body: 'edited' }, first.wrappedKey);
    // Same wrapped note key is kept across edits...
    expect(second.wrappedKey).toEqual(first.wrappedKey);
    // ...and both decrypt correctly.
    const dec = await decryptNotePayload(mk, {
      id: 'n', ciphertext: second.ciphertext, iv: second.iv, wrappedKey: second.wrappedKey,
      createdAt: 0, updatedAt: 0, deleted: false,
    });
    expect(dec.body).toBe('edited');
  });

  it('a different master key cannot decrypt', async () => {
    const enc = await encryptNotePayload(generateMasterKey(), payload);
    const record: NoteRecord = {
      id: 'n', ciphertext: enc.ciphertext, iv: enc.iv, wrappedKey: enc.wrappedKey,
      createdAt: 0, updatedAt: 0, deleted: false,
    };
    await expect(decryptNotePayload(generateMasterKey(), record)).rejects.toThrow();
  });

  it('unwrapNoteKey yields the raw note key that encryptWithNoteKey can reuse', async () => {
    const mk = generateMasterKey();
    const enc = await encryptNotePayload(mk, payload);
    const noteKey = await unwrapNoteKey(mk, enc.wrappedKey);
    expect(noteKey.length).toBe(32);
    // Re-encrypt with the unwrapped key and decrypt with the same wrappedKey.
    const re = await encryptWithNoteKey(noteKey, { ...payload, title: 'Re' });
    const dec = await decryptNotePayload(mk, {
      id: 'n', ciphertext: re.ciphertext, iv: re.iv, wrappedKey: enc.wrappedKey,
      createdAt: 0, updatedAt: 0, deleted: false,
    });
    expect(dec.title).toBe('Re');
  });
});

describe('shared note decryption (sealKey / decryptSharedNotePayload)', () => {
  it('owner seals a note key to a recipient who can then decrypt the note', async () => {
    const recipient = generateKeyPair();
    const noteKey = randomBytes(32);
    const { ciphertext, iv } = await encryptWithNoteKey(noteKey, payload);
    const sealedKey = await sealKey(recipient.publicKey, noteKey);
    const record: SharedNoteRecord = {
      id: 's1', ciphertext, iv, sealedKey, ownerUsername: 'owner', access: 'read', createdAt: 0, updatedAt: 0,
    };
    const { payload: out, noteKeyRaw } = await decryptSharedNotePayload(recipient.privateKey, recipient.publicKey, record);
    expect(out).toEqual(payload);
    expect(noteKeyRaw).toEqual(noteKey);
  });

  it('a non-recipient cannot decrypt the shared note', async () => {
    const recipient = generateKeyPair();
    const attacker = generateKeyPair();
    const noteKey = randomBytes(32);
    const { ciphertext, iv } = await encryptWithNoteKey(noteKey, payload);
    const record: SharedNoteRecord = {
      id: 's', ciphertext, iv, sealedKey: await sealKey(recipient.publicKey, noteKey),
      ownerUsername: 'o', access: 'read', createdAt: 0, updatedAt: 0,
    };
    await expect(decryptSharedNotePayload(attacker.privateKey, attacker.publicKey, record)).rejects.toThrow();
  });
});

describe('attachment blob encryption (encryptBlob / decryptBlob)', () => {
  it('round-trips arbitrary bytes', async () => {
    const data = randomBytes(256);
    const { ciphertext, key, iv } = await encryptBlob(data);
    expect(await decryptBlob(ciphertext, key, iv)).toEqual(data);
  });

  it('rejects a tampered blob (GCM auth)', async () => {
    const { ciphertext, key, iv } = await encryptBlob(randomBytes(64));
    const bytes = new Uint8Array(ciphertext);
    bytes[0] ^= 0xff;
    await expect(decryptBlob(bytes, key, iv)).rejects.toThrow();
  });

  it('rejects the wrong key', async () => {
    const { ciphertext, iv } = await encryptBlob(randomBytes(64));
    await expect(decryptBlob(ciphertext, b64(randomBytes(32)), iv)).rejects.toThrow();
    // sanity: ub64/b64 of the key round-trips
    expect(ub64(b64(randomBytes(32))).length).toBe(32);
  });
});
