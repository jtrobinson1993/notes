import type { AttachmentRef } from '@notes/shared';
import { encryptBlob } from './crypto';
import { nameForType } from './fileMeta';
import { optimizeImage } from './imageOptimize';
import { optimizeImages } from './privacy';
import { api } from './api';

// Mirror of the server cap (server/src/routes/attachments.ts). +16 accounts for
// the AES-GCM auth tag added by encryptBlob.
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** Optimize (images, when enabled), encrypt, and upload one file; returns the
 *  AttachmentRef to embed inside an encrypted payload (note or chat message).
 *  The blob the server stores is ciphertext; the key lives only in the ref. */
export async function encryptAndUploadFile(file: File): Promise<AttachmentRef> {
  let data: Uint8Array = new Uint8Array(await file.arrayBuffer());
  let type = file.type || 'application/octet-stream';
  let name = file.name;
  if (optimizeImages.value) {
    const optimized = await optimizeImage(data, type);
    // Re-encoding changed the format → drop the now-misleading original
    // extension so the name matches the bytes (e.g. `photo.jpeg` → `photo.webp`).
    if (optimized.type !== type) name = nameForType(name, optimized.type);
    data = optimized.data;
    type = optimized.type;
  }
  if (data.length + 16 > MAX_ATTACHMENT_BYTES) {
    throw new Error('file too large');
  }
  const { ciphertext, key, iv } = await encryptBlob(data);
  const { id } = await api.attachmentUpload(ciphertext);
  return { id, name, type, size: data.length, key, iv };
}
