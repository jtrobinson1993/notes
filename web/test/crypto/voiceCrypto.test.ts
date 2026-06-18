import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '../../src/lib/crypto';
import { b64 } from '../../src/lib/b64';
import {
  decryptFrame,
  encryptFrame,
  generateMediaKey,
  importFrameKey,
  sealMediaKey,
  unsealMediaKey,
} from '../../src/lib/voiceCrypto';

const payload = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const text = (b: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(b));

describe('voiceCrypto — media key distribution', () => {
  it('seals a media key to a member and they can unseal it', async () => {
    const recipient = generateKeyPair();
    const mediaKey = generateMediaKey();
    const sealed = await sealMediaKey(b64(recipient.publicKey), mediaKey);
    const got = await unsealMediaKey(sealed, recipient.privateKey, recipient.publicKey);
    expect([...got]).toEqual([...mediaKey]);
  });
});

describe('voiceCrypto — frame encryption', () => {
  it('round-trips an encoded frame under the matching epoch key', async () => {
    const key = await importFrameKey(generateMediaKey());
    const ct = await encryptFrame(7, key, payload('hello opus'));
    const pt = await decryptFrame((e) => (e === 7 ? key : undefined), ct);
    expect(pt).not.toBeNull();
    expect(text(pt!)).toBe('hello opus');
  });

  it('tags the frame with its epoch so the receiver selects the right key', async () => {
    const k0 = await importFrameKey(generateMediaKey());
    const k1 = await importFrameKey(generateMediaKey());
    const f0 = await encryptFrame(0, k0, payload('epoch zero'));
    const f1 = await encryptFrame(1, k1, payload('epoch one'));
    const keyFor = (e: number) => (e === 0 ? k0 : e === 1 ? k1 : undefined);
    expect(text((await decryptFrame(keyFor, f0))!)).toBe('epoch zero');
    expect(text((await decryptFrame(keyFor, f1))!)).toBe('epoch one');
  });

  it('returns null for an unknown epoch (no key) rather than throwing', async () => {
    const key = await importFrameKey(generateMediaKey());
    const ct = await encryptFrame(3, key, payload('x'));
    expect(await decryptFrame(() => undefined, ct)).toBeNull();
  });

  it('rejects a tampered frame (auth-tag failure) by returning null', async () => {
    const key = await importFrameKey(generateMediaKey());
    const ct = await encryptFrame(2, key, payload('authentic'));
    const bytes = new Uint8Array(ct);
    bytes[bytes.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(await decryptFrame((e) => (e === 2 ? key : undefined), bytes.buffer)).toBeNull();
  });

  it('rejects decryption under the wrong epoch key', async () => {
    const right = await importFrameKey(generateMediaKey());
    const wrong = await importFrameKey(generateMediaKey());
    const ct = await encryptFrame(5, right, payload('secret'));
    expect(await decryptFrame((e) => (e === 5 ? wrong : undefined), ct)).toBeNull();
  });

  it('returns null for a runt frame shorter than the header', async () => {
    const key = await importFrameKey(generateMediaKey());
    expect(await decryptFrame(() => key, new Uint8Array(4).buffer)).toBeNull();
  });
});
