/**
 * Pure pan/zoom math for the image lightbox (`ImageLightbox.vue`).
 *
 * The image is laid out fit-to-viewport at scale 1 and transformed with
 * `translate(pan) scale(s)`, transform-origin center. Keeping the math here
 * (free of DOM/Vue) lets us unit-test the zoom-to-cursor and pan-clamp rules.
 */

export interface Point {
  x: number;
  y: number;
}

// `+ 0` normalises `-0` (which clamping a negative against a 0 bound can yield)
// to `+0` — cosmetic, but keeps transforms and `toEqual` assertions tidy.
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v)) + 0;

/** Smallest scale (image fits the viewport) and the most we let the user zoom. */
export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
/** Scale a single click-to-zoom jumps to from the fit state. */
export const CLICK_ZOOM = 2.5;

/**
 * New pan so the point under the cursor stays fixed when scaling `s0`→`s1`.
 * `rel` is the cursor offset from the image's current on-screen center (px).
 *
 * Scaling expands the image outward from its centre, so a point at offset `rel`
 * drifts by `rel·(s1/s0−1)`; we translate by the negative of that to pin it.
 */
export function zoomToPoint(pan: Point, s0: number, s1: number, rel: Point): Point {
  const k = 1 - s1 / s0;
  return { x: pan.x + rel.x * k, y: pan.y + rel.y * k };
}

/**
 * Clamp a pan offset so the scaled image never reveals a gap past its edges.
 * At scale `s` the image overflows its fit box by `(s−1)·size` total, i.e.
 * `(s−1)·size/2` per side — that's the furthest the centre may travel.
 */
export function clampPan(pan: Point, scale: number, renderedW: number, renderedH: number): Point {
  const maxX = Math.max(0, ((scale - 1) * renderedW) / 2);
  const maxY = Math.max(0, ((scale - 1) * renderedH) / 2);
  return { x: clamp(pan.x, -maxX, maxX), y: clamp(pan.y, -maxY, maxY) };
}

/** Clamp a requested scale into the allowed range. */
export function clampScale(scale: number): number {
  return clamp(scale, MIN_SCALE, MAX_SCALE);
}
