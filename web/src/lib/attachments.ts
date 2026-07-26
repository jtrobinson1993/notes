import type { AttachmentRef } from '@notes/shared';
import { randomBytes } from './crypto';
import { ub64 } from './b64';
import { attachmentEvict, attachmentGet, attachmentPut } from './native';

// Cap kept in step with the relay's blob ceiling. +16 accounts for the AES-GCM
// auth tag added by encryptBlob.
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

// Tighter client cap for media: images (measured *after* optimization) and
// videos. Keeps a single attachment from being tens of MB even once an image is
// downscaled/re-encoded — a huge source PNG can still be a big WebP. Other file
// types keep the full ceiling.
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/** Upload size limit for `type`: the media cap for images/videos, else the
 *  full ceiling. */
export function attachmentCap(type: string): number {
  return type.startsWith('image/') || type.startsWith('video/') ? MAX_MEDIA_BYTES : MAX_ATTACHMENT_BYTES;
}

// ---- note attachments ----
//
// Notes are local-only (no relay sync yet), so their attachments never leave the
// device: the ciphertext goes straight into the vault's blob store.

/** Store one note attachment's ciphertext and return the id to reference it by. */
export async function putNoteAttachment(
  noteId: string,
  ciphertext: Uint8Array,
  meta: { key: string; iv: string; type: string; size: number },
): Promise<string> {
  // The relay assigns blob ids on the chat path; a local-only note has no
  // server to ask, so mint one here. base64url keeps it inside the charset the
  // blob store accepts (it becomes a path segment).
  const id = b64url(randomBytes(32));
  await attachmentPut(
    {
      id,
      owner_kind: 'note',
      owner_id: noteId,
      file_key: Array.from(ub64(meta.key)),
      iv: Array.from(ub64(meta.iv)),
      thumb: null,
      size: meta.size,
      mime: meta.type,
      content_hash: null,
    },
    Array.from(ciphertext),
  );
  return id;
}

/** Read one note attachment's ciphertext back. `null` when the device no longer
 *  holds it (evicted) — there is no relay copy of a note attachment to refetch,
 *  so the caller renders it as missing rather than retrying forever. */
export async function getNoteAttachmentCiphertext(id: string): Promise<Uint8Array | null> {
  const { bytes } = await attachmentGet(id);
  return bytes ? Uint8Array.from(bytes) : null;
}

/** Reclaim a note attachment's on-device ciphertext once nothing references it. */
export async function deleteNoteAttachment(id: string): Promise<void> {
  await attachmentEvict(id);
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
