import { describe, expect, it } from 'vitest';
import {
  decryptFrame,
  encryptFrame,
  generateMediaKey,
  importFrameKey,
} from '../../src/lib/voiceCrypto';

const payload = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const text = (b: ArrayBuffer) => new TextDecoder().decode(new Uint8Array(b));

// Media-key *distribution* is no longer a web concern: the Rust core mints the
// call's frame key and seals it to the callee inside the call-offer envelope
// (`relay_call_offer` in `src-tauri/src/lib.rs`, sealing via
// `src-tauri/src/envelope.rs`), so the relay/SFU never sees it. That sealing is
// covered by the Rust tests in `envelope.rs` and `message.rs`. The web side only
// imports the delivered key as a frame key — covered below.

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
