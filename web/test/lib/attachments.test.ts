import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ attachmentUpload: vi.fn() }));
vi.mock('../../src/lib/api', () => ({ api }));

import { encryptAndUploadFile, MAX_ATTACHMENT_BYTES } from '../../src/lib/attachments';
import { decryptBlob } from '../../src/lib/crypto';

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

  it('rejects a file over the size cap before uploading', async () => {
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    await expect(encryptAndUploadFile(file('big.bin', 'application/octet-stream', big))).rejects.toThrow(/too large/);
    expect(api.attachmentUpload).not.toHaveBeenCalled();
  });
});
