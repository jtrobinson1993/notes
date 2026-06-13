// Client-side image optimization that runs on raw bytes BEFORE encryption and
// upload (the server only ever receives ciphertext, so this is the only place
// it can happen). We decode the image, downscale anything larger than
// MAX_DIMENSION, and re-encode to WebP. Optimization is strictly best-effort:
// any failure, or a result that isn't actually smaller, falls back to the
// original bytes so an upload is never blocked or broken.

// Cap the largest dimension; preserves aspect ratio when scaling down.
const MAX_DIMENSION = 2560;
// WebP quality (0..1). 0.82 is a good size/quality trade-off for photos.
const WEBP_QUALITY = 0.82;

/**
 * Optimize an image for upload. Returns the (possibly) re-encoded bytes and the
 * resulting MIME type. Non-images, animated GIFs and SVGs are returned
 * unchanged, as is any image that wouldn't actually get smaller.
 */
export async function optimizeImage(
  data: Uint8Array,
  mimeType: string,
): Promise<{ data: Uint8Array; type: string }> {
  // Not an image, or a format we deliberately leave alone:
  // - GIF: decoding to canvas would flatten an animation to a single frame.
  // - SVG: vector; rasterizing would lose scalability and likely grow in size.
  if (!mimeType.startsWith('image/') || mimeType === 'image/gif' || mimeType === 'image/svg+xml') {
    return { data, type: mimeType };
  }

  try {
    const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type: mimeType }));

    // Scale down to fit MAX_DIMENSION on the longest side, preserving aspect ratio.
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > MAX_DIMENSION ? MAX_DIMENSION / longest : 1;
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const blob = await drawToWebp(bitmap, width, height);
    bitmap.close();

    // Never upload something bigger than what we started with.
    if (!blob || blob.size >= data.length) {
      return { data, type: mimeType };
    }
    return { data: new Uint8Array(await blob.arrayBuffer()), type: 'image/webp' };
  } catch (err) {
    // Optimization must never block or break an upload.
    console.warn('image optimization failed, uploading original', err);
    return { data, type: mimeType };
  }
}

/**
 * Draw a bitmap to a canvas at the given size and encode it as WebP. Uses
 * OffscreenCanvas where available and falls back to a detached HTMLCanvasElement
 * (e.g. older Safari) via feature detection.
 */
async function drawToWebp(bitmap: ImageBitmap, width: number, height: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/webp', quality: WEBP_QUALITY });
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/webp', WEBP_QUALITY);
  });
}
