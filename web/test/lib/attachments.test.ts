import { afterEach, describe, expect, it, vi } from 'vitest';

// There is only one shell now (native), so the vault blob store is the only
// backing for a note attachment — no server upload path to branch on.
const native = vi.hoisted(() => ({
  attachmentPut: vi.fn(),
  attachmentGet: vi.fn(),
  attachmentEvict: vi.fn(),
}));
vi.mock('../../src/lib/native', () => native);

import {
  attachmentCap,
  deleteNoteAttachment,
  getNoteAttachmentCiphertext,
  MAX_ATTACHMENT_BYTES,
  MAX_MEDIA_BYTES,
  putNoteAttachment,
} from '../../src/lib/attachments';
import { encryptBlob } from '../../src/lib/crypto';

afterEach(() => vi.clearAllMocks());

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
  it('keeps the ciphertext in the vault, never the plaintext', async () => {
    const plaintext = new Uint8Array([4, 5, 6]);
    const { ciphertext, key, iv } = await encryptBlob(plaintext);

    const id = await putNoteAttachment('note-1', ciphertext, {
      key,
      iv,
      type: 'image/webp',
      size: 3,
    });

    const [meta, bytes] = native.attachmentPut.mock.calls[0];
    expect(meta.id).toBe(id);
    expect(meta.owner_kind).toBe('note');
    expect(meta.owner_id).toBe('note-1');
    expect(meta.mime).toBe('image/webp');
    expect(meta.size).toBe(3);
    // The key travels as raw bytes for the SQLCipher row, and the blob stored
    // is the ciphertext — never the plaintext.
    expect(meta.file_key).toHaveLength(32);
    expect(meta.iv).toHaveLength(12);
    expect(bytes).toEqual(Array.from(ciphertext));
    expect(bytes).not.toEqual(Array.from(plaintext));

    // The id has to survive being used as a filesystem path segment.
    expect(id).toMatch(/^[A-Za-z0-9_-]{3,}$/);
  });

  it('mints a distinct, unguessable id per attachment', async () => {
    const put = (n: number) =>
      putNoteAttachment('note-1', new Uint8Array([n]), {
        key: 'a'.repeat(43) + '=',
        iv: 'b'.repeat(15) + '=',
        type: 'text/plain',
        size: 1,
      });
    const a = await put(1);
    const b = await put(2);
    expect(a).not.toBe(b);
    // 32 random bytes → 43 base64url chars (no padding).
    expect(a).toHaveLength(43);
  });

  it('reports an evicted attachment as missing rather than retrying', async () => {
    native.attachmentGet.mockResolvedValue({ meta: {}, bytes: null });
    // There is no relay copy of a note attachment, so `null` is terminal — the
    // caller renders "missing" instead of looping on a fetch that can't succeed.
    expect(await getNoteAttachmentCiphertext('gone')).toBeNull();
  });

  it('reads a present attachment back out of the vault', async () => {
    native.attachmentGet.mockResolvedValue({ meta: {}, bytes: [7, 8, 9] });
    const back = await getNoteAttachmentCiphertext('here');
    expect(back).toBeInstanceOf(Uint8Array);
    expect([...back!]).toEqual([7, 8, 9]);
  });

  it('evicts an unreferenced attachment from the blob store', async () => {
    await deleteNoteAttachment('dead');
    expect(native.attachmentEvict).toHaveBeenCalledWith('dead');
  });
});
