/**
 * Pure layout math for a chat message's image gallery. Kept framework-free so
 * it's unit-testable in isolation (the Vue grid component just renders what
 * these return).
 */

/** Beyond this many images in one message, extra tiles collapse behind a
 *  `+N` overlay on the last visible tile. Six so the collapsed grid fills two
 *  even rows of three rather than a lopsided 3 + 2. */
export const MAX_GALLERY_TILES = 6;

export interface GalleryLayout {
  /** How many thumbnails to actually render (never more than the cap). */
  visibleCount: number;
  /** Images hidden behind the overlay — the `N` in `+N`; 0 when all fit. */
  overflow: number;
  /** Grid column count chosen to tile the visible thumbnails evenly. */
  cols: number;
}

/**
 * Decide how to lay out `count` images:
 * - 1 image renders on its own (natural aspect; `cols` is 1).
 * - 2 or 4 tile in two columns; everything else in three.
 * - More than `MAX_GALLERY_TILES` (6) shows the first six tiles (two even rows of
 *   three) and stacks the remainder under a `+N` badge on the last visible one.
 */
export function galleryLayout(count: number): GalleryLayout {
  const visibleCount = Math.min(count, MAX_GALLERY_TILES);
  const overflow = Math.max(0, count - MAX_GALLERY_TILES);
  const cols = count <= 1 ? 1 : count === 2 || count === 4 ? 2 : 3;
  return { visibleCount, overflow, cols };
}

/**
 * Step a lightbox index by `delta`, clamped to `[0, len)` (no wrap-around, so
 * the prev/next arrows simply disable at the ends). Returns the original index
 * for an empty list or an out-of-range start.
 */
export function stepIndex(current: number, delta: number, len: number): number {
  if (len <= 0) return current;
  const next = current + delta;
  if (next < 0) return 0;
  if (next > len - 1) return len - 1;
  return next;
}
