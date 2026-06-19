// Web Worker running the WebRTC Encoded Transform (insertable streams) for E2EE
// voice. The main thread delivers per-epoch media keys via postMessage; this
// worker encrypts each outgoing encoded audio frame and decrypts incoming ones,
// so plaintext audio never reaches the SFU. Frames that can't be decrypted (no
// key / wrong epoch / tampered) are dropped rather than played.
//
// NOTE: browser-runtime only — exercised by manual two-browser testing, not CI
// (no WebRTC / RTCRtpScriptTransform in jsdom/Node). The pure frame crypto it
// calls is unit-tested in web/test/crypto/voiceCrypto.test.ts.
import { decryptFrame, encryptFrame } from './voiceCrypto';

interface EncodedFrame {
  data: ArrayBuffer;
}

const keys = new Map<number, CryptoKey>();
let sendEpoch = -1;

const ctx = self as unknown as { addEventListener(type: string, cb: (e: unknown) => void): void };

ctx.addEventListener('message', (e: unknown) => {
  const d = (e as MessageEvent).data as { type: string; epoch?: number; raw?: ArrayBuffer };
  if (d.type === 'key' && typeof d.epoch === 'number' && d.raw) {
    void crypto.subtle
      .importKey('raw', d.raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
      .then((key) => keys.set(d.epoch as number, key));
  } else if (d.type === 'sendEpoch' && typeof d.epoch === 'number') {
    sendEpoch = d.epoch;
  } else if (d.type === 'dropEpoch' && typeof d.epoch === 'number') {
    keys.delete(d.epoch);
  }
});

ctx.addEventListener('rtctransform', (event: unknown) => {
  const transformer = (event as { transformer: { options?: { operation?: string }; readable: ReadableStream; writable: WritableStream } }).transformer;
  const op = transformer.options?.operation;
  const stream = new TransformStream({
    async transform(frame: EncodedFrame, controller: TransformStreamDefaultController) {
      try {
        if (op === 'encrypt') {
          const key = keys.get(sendEpoch);
          if (!key) return; // no media key yet → drop, never send plaintext
          frame.data = await encryptFrame(sendEpoch, key, frame.data);
        } else {
          const pt = await decryptFrame((ep) => keys.get(ep), frame.data);
          if (!pt) return; // undecryptable → drop
          frame.data = pt;
        }
        controller.enqueue(frame);
      } catch {
        /* drop frame on any error */
      }
    },
  });
  transformer.readable.pipeThrough(stream).pipeTo(transformer.writable);
});
