import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ attachmentUpload: vi.fn(), attachmentDownload: vi.fn() }));
vi.mock('../../src/lib/api', () => ({ api }));

// The native bridge, with `isNative` flippable per test so both shells are
// exercised from one suite.
const native = vi.hoisted(() => ({
  isNative: false,
  attachmentPut: vi.fn(),
  attachmentGet: vi.fn(),
}));
vi.mock('../../src/lib/native', () => ({
  get isNative() {
    return native.isNative;
  },
  attachmentPut: native.attachmentPut,
  attachmentGet: native.attachmentGet,
}));

// Stub the canvas-based optimizer (unavailable in jsdom). Defaults to a
// passthrough; individual tests override it to simulate a re-encode.
const optimize = vi.hoisted(() => ({
  optimizeImage: vi.fn(async (data: Uint8Array, type: string) => ({ data, type })),
}));
vi.mock('../../src/lib/imageOptimize', () => optimize);

import {
  attachmentCap,
  encryptAndUploadFile,
  getNoteAttachmentCiphertext,
  MAX_ATTACHMENT_BYTES,
  MAX_MEDIA_BYTES,
  putNoteAttachment,
} from '../../src/lib/attachments';
import { decryptBlob, encryptBlob } from '../../src/lib/crypto';

function file(name: string, type: string, bytes: Uint8Array): File {
  return new File([bytes as BlobPart], name, { type });
}

afterEach(() => vi.clearAllMocks());

describe('encryptAndUploadFile', () => {
  it('uploads ciphertext and returns a ref whose key/iv decrypt back to the bytes', async () => {
    api.attachmentUpload.mockResolvedValue({ id: 'abc', size: 99 });
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
    const ref = await encryptAndUploadFile(file('note.txt', 'text/plain', plaintext));

    expect(api.attachmentUpload).toHaveBeenCalledOnce();
    const sent = api.attachmentUpload.mock.calls[0][0] as Uint8Array;
    // The server only ever sees ciphertext (plaintext + GCM tag), not the bytes.
    expect(sent.length).toBeGreaterThan(plaintext.length);
    expect(ref).toMatchObject({ id: 'abc', name: 'note.txt', type: 'text/plain', size: 5 });

    const back = await decryptBlob(sent, ref.key, ref.iv);
    expect([...back]).toEqual([...plaintext]);
  });

  it('rewrites the name extension when optimization changes the format', async () => {
    api.attachmentUpload.mockResolvedValue({ id: 'opt' });
    const webp = new Uint8Array([7, 7, 7]);
    optimize.optimizeImage.mockResolvedValueOnce({ data: webp, type: 'image/webp' });

    const ref = await encryptAndUploadFile(file('DSCF3984.jpeg', 'image/jpeg', new Uint8Array(20)));

    // The misleading `.jpeg` is dropped so the name matches the stored bytes.
    expect(ref).toMatchObject({ name: 'DSCF3984.webp', type: 'image/webp', size: 3 });
  });

  it('rejects a file over the size cap before uploading', async () => {
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    await expect(encryptAndUploadFile(file('big.bin', 'application/octet-stream', big))).rejects.toThrow(/too large/);
    expect(api.attachmentUpload).not.toHaveBeenCalled();
  });

  it('rejects an image still over the 20MB media cap after optimization', async () => {
    optimize.optimizeImage.mockResolvedValueOnce({ data: new Uint8Array(MAX_MEDIA_BYTES + 1), type: 'image/webp' });
    await expect(encryptAndUploadFile(file('huge.png', 'image/png', new Uint8Array(4)))).rejects.toThrow(/too large/);
    expect(api.attachmentUpload).not.toHaveBeenCalled();
  });

  it('rejects a video over the 20MB media cap (videos are not optimized)', async () => {
    const big = new Uint8Array(MAX_MEDIA_BYTES + 1);
    await expect(encryptAndUploadFile(file('clip.mp4', 'video/mp4', big))).rejects.toThrow(/too large/);
    expect(api.attachmentUpload).not.toHaveBeenCalled();
  });
});

describe('attachmentCap', () => {
  it('caps images and videos at the media limit, others at the server ceiling', () => {
    expect(attachmentCap('image/png')).toBe(MAX_MEDIA_BYTES);
    expect(attachmentCap('video/mp4')).toBe(MAX_MEDIA_BYTES);
    expect(attachmentCap('application/pdf')).toBe(MAX_ATTACHMENT_BYTES);
    expect(attachmentCap('audio/mpeg')).toBe(MAX_ATTACHMENT_BYTES);
    expect(MAX_MEDIA_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_MEDIA_BYTES).toBeLessThan(MAX_ATTACHMENT_BYTES);
  });
});

describe('note attachments', () => {
  afterEach(() => {
    native.isNative = false;
  });

  it('in a browser, stores and reads through the legacy server endpoints', async () => {
    api.attachmentUpload.mockResolvedValue({ id: 'server-id' });
    const id = await putNoteAttachment('note-1', new Uint8Array([9, 9]), {
      key: 'a'.repeat(43) + '=',
      iv: 'b'.repeat(15) + '=',
      type: 'image/webp',
      size: 2,
    });
    expect(id).toBe('server-id');
    expect(native.attachmentPut).not.toHaveBeenCalled();

    api.attachmentDownload.mockResolvedValue(new Uint8Array([1, 2]));
    expect([...(await getNoteAttachmentCiphertext('server-id'))!]).toEqual([1, 2]);
  });

  it('in the native shell, keeps the ciphertext in the vault instead of a server', async () => {
    native.isNative = true;
    const { ciphertext, key, iv } = await encryptBlob(new Uint8Array([4, 5, 6]));

    const id = await putNoteAttachment('note-1', ciphertext, {
      key,
      iv,
      type: 'image/webp',
      size: 3,
    });

    // Nothing is uploaded: a local-only note has no relay copy.
    expect(api.attachmentUpload).not.toHaveBeenCalled();
    const [meta, bytes] = native.attachmentPut.mock.calls[0];
    expect(meta.id).toBe(id);
    expect(meta.owner_kind).toBe('note');
    expect(meta.owner_id).toBe('note-1');
    expect(meta.mime).toBe('image/webp');
    // The key travels as raw bytes for the SQLCipher row, and the blob stored
    // is the ciphertext — never the plaintext.
    expect(meta.file_key).toHaveLength(32);
    expect(meta.iv).toHaveLength(12);
    expect(bytes).toEqual(Array.from(ciphertext));

    // The id has to survive being used as a filesystem path segment.
    expect(id).toMatch(/^[A-Za-z0-9_-]{3,}$/);
  });

  it('mints a distinct id per native attachment', async () => {
    native.isNative = true;
    const put = (n: number) =>
      putNoteAttachment('note-1', new Uint8Array([n]), {
        key: 'a'.repeat(43) + '=',
        iv: 'b'.repeat(15) + '=',
        type: 'text/plain',
        size: 1,
      });
    expect(await put(1)).not.toBe(await put(2));
  });

  it('reports an evicted native attachment as missing rather than retrying', async () => {
    native.isNative = true;
    native.attachmentGet.mockResolvedValue({ meta: {}, bytes: null });
    // There is no relay copy of a note attachment, so `null` is terminal — the
    // caller renders "missing" instead of looping on a fetch that can't succeed.
    expect(await getNoteAttachmentCiphertext('gone')).toBeNull();
    expect(api.attachmentDownload).not.toHaveBeenCalled();
  });

  it('reads a present native attachment back out of the vault', async () => {
    native.isNative = true;
    native.attachmentGet.mockResolvedValue({ meta: {}, bytes: [7, 8, 9] });
    expect([...(await getNoteAttachmentCiphertext('here'))!]).toEqual([7, 8, 9]);
  });
});
