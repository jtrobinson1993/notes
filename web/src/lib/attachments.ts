import type { AttachmentRef } from '@notes/shared';
import { decryptBlob, encryptBlob } from './crypto';
import { formatBytes, nameForType } from './fileMeta';
import { optimizeImage } from './imageOptimize';
import { optimizeImages } from './privacy';
import { api } from './api';

// Mirror of the server cap (server/src/routes/attachments.ts). +16 accounts for
// the AES-GCM auth tag added by encryptBlob.
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

// Tighter client cap for media: images (measured *after* optimization) and
// videos. Keeps a single attachment from being tens of MB even once an image is
// downscaled/re-encoded — a huge source PNG can still be a big WebP. Other file
// types keep the full server ceiling.
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/** Upload size limit for `type`: the media cap for images/videos, else the
 *  server ceiling. */
export function attachmentCap(type: string): number {
  return type.startsWith('image/') || type.startsWith('video/') ? MAX_MEDIA_BYTES : MAX_ATTACHMENT_BYTES;
}

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
  const cap = attachmentCap(type);
  if (data.length + 16 > cap) {
    throw new Error(`too large (${formatBytes(data.length)}, max ${formatBytes(cap)})`);
  }
  const { ciphertext, key, iv } = await encryptBlob(data);
  const { id } = await api.attachmentUpload(ciphertext);
  const ref: AttachmentRef = { id, name, type, size: data.length, key, iv };

  // Videos: capture a poster frame + intrinsic dimensions so the recipient can
  // show a correctly-sized thumbnail before decrypting the (often large) clip.
  // Best-effort — a failure just omits the poster (falls back to a chip).
  if (type.startsWith('video/')) {
    const shot = await videoPoster(file).catch(() => null);
    if (shot) {
      ref.width = shot.width;
      ref.height = shot.height;
      try {
        const enc = await encryptBlob(shot.bytes);
        const up = await api.attachmentUpload(enc.ciphertext);
        ref.poster = { id: up.id, key: enc.key, iv: enc.iv, type: 'image/webp' };
      } catch {
        /* keep the dimensions even if the poster upload failed */
      }
    }
  }
  return ref;
}

/** Capture a video's first frame (downscaled WebP) + intrinsic size, for use as
 *  a poster. Best-effort: returns null on any failure (unsupported codec, no
 *  canvas, …) so an upload is never blocked. */
async function videoPoster(
  file: File,
): Promise<{ width: number; height: number; bytes: Uint8Array } | null> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('video load failed'));
    });
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;
    // Downscale the poster (keep the aspect ratio); the intrinsic w/h above is
    // what the UI uses to size the thumbnail.
    const longest = Math.max(width, height);
    const scale = longest > 640 ? 640 / longest : 1;
    const cw = Math.max(1, Math.round(width * scale));
    const ch = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, cw, ch);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.7));
    if (!blob) return null;
    return { width, height, bytes: new Uint8Array(await blob.arrayBuffer()) };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Download one attachment's ciphertext and decrypt it locally to its bytes.
 *  Decryption is local, so there's no remote render (no IP leak). Shared by the
 *  inline image grid and the file-download chip. */
export async function decryptAttachment(ref: Pick<AttachmentRef, 'id' | 'key' | 'iv'>): Promise<Uint8Array> {
  const ct = await api.attachmentDownload(ref.id);
  return decryptBlob(ct, ref.key, ref.iv);
}
