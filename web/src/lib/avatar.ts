// Avatar processing: the user picks an image, frames a square crop (zoom + pan)
// in AvatarCropper.vue, and we render that crop to a small square WebP data URL
// embedded inside the encrypted profile blob. Everything runs client-side — the
// server only ever sees the ciphertext.

/** Output edge length, in px. A 256² WebP stays well under the profile budget. */
export const AVATAR_SIZE = 256;
/** Reject absurdly large source files before we try to decode them. */
export const MAX_AVATAR_INPUT_BYTES = 25 * 1024 * 1024; // 25 MB
const WEBP_QUALITY = 0.85;

// ---- Pure crop geometry (unit-tested; no DOM) ----------------------------

/** The scale at which the image's *shorter* side exactly covers a square
 *  viewport — the minimum zoom that still fills the frame with no gaps. */
export function coverScale(naturalW: number, naturalH: number, viewport: number): number {
  return viewport / Math.max(1, Math.min(naturalW, naturalH));
}

/** Clamp a pan offset (px, ≤ 0) so the scaled image always fully covers the
 *  viewport — you can't drag a gap into frame. */
export function clampOffset(offset: number, displaySize: number, viewport: number): number {
  return Math.max(Math.min(0, viewport - displaySize), Math.min(0, offset));
}

/** Map the square viewport back to a crop rectangle in source-image pixels. */
export function sourceRect(
  offsetX: number,
  offsetY: number,
  effScale: number,
  viewport: number,
): { sx: number; sy: number; size: number } {
  // `+ 0` normalizes -0 (offset 0) to 0 — cosmetic, but keeps results clean.
  return { sx: -offsetX / effScale + 0, sy: -offsetY / effScale + 0, size: viewport / effScale };
}

// ---- DOM / encoding ------------------------------------------------------

/** Decode a File into an <img>. The caller revokes `img.src` when finished. */
export function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That file isn't an image we can read. Try a PNG, JPEG, or WebP."));
    };
    img.src = url;
  });
}

/** Render a source crop rect to a square WebP (PNG fallback) data URL. */
export async function cropToDataUrl(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  size: number,
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser blocked image processing (no canvas).');
  ctx.drawImage(source, sx, sy, size, size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const blob = await canvasToBlob(canvas);
  return blobToDataUrl(blob);
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // Prefer WebP; fall back to PNG if the browser can't encode WebP.
    canvas.toBlob(
      (webp) => {
        if (webp) return resolve(webp);
        canvas.toBlob(
          (png) => (png ? resolve(png) : reject(new Error('Could not encode the image.'))),
          'image/png',
        );
      },
      'image/webp',
      WEBP_QUALITY,
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Could not read the processed image.'));
    reader.readAsDataURL(blob);
  });
}
