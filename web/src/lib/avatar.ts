// Turn a user-picked image into a small, square WebP data URL suitable for
// embedding inside the encrypted profile blob. Runs entirely client-side (the
// server only ever sees the ciphertext), center-cropping to a square and
// downscaling so the encoded avatar stays well under the profile size budget.

const AVATAR_SIZE = 256;
const WEBP_QUALITY = 0.8;

export async function fileToAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  // Center-crop to a square, then scale to AVATAR_SIZE.
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const blob = await drawSquareWebp(bitmap, sx, sy, side);
  bitmap.close();
  if (!blob) throw new Error('could not process image');
  return blobToDataUrl(blob);
}

async function drawSquareWebp(
  bitmap: ImageBitmap,
  sx: number,
  sy: number,
  side: number,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(AVATAR_SIZE, AVATAR_SIZE);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    return canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
  }
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/webp', WEBP_QUALITY));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('could not read image'));
    reader.readAsDataURL(blob);
  });
}
