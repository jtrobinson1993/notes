/**
 * Pure layout math for a chat message's image gallery. Kept framework-free so
 * it's unit-testable in isolation (the Vue strip component just renders what
 * these return).
 */

/** Beyond this many images in one message, extra tiles collapse behind a
 *  `+N` overlay on the last visible tile. Four keeps the inline strip compact;
 *  the rest are one tap away in the lightbox. */
export const MAX_GALLERY_TILES = 4;

/** Fixed height (px) every thumbnail shares, so a message's images line up as an
 *  even strip regardless of their aspect ratios. */
export const TILE_HEIGHT = 160;
/** Floor on a thumbnail's width: very tall/narrow images are letterboxed to this
 *  against the tile background rather than collapsing to a sliver. */
export const TILE_MIN_WIDTH = 96;
/** Ceiling on a thumbnail's width: extremely wide (panorama) images are capped
 *  here and center-cropped, instead of stretching the strip off the message. */
export const TILE_MAX_WIDTH = 280;

export interface GalleryLayout {
  /** How many thumbnails to actually render (never more than the cap). */
  visibleCount: number;
  /** Images hidden behind the overlay — the `N` in `+N`; 0 when all fit. */
  overflow: number;
}

/**
 * Decide how many of `count` images to show inline: up to `MAX_GALLERY_TILES`
 * tiles, with any remainder stacked under a `+N` badge on the last visible one.
 * The tiles themselves are a wrapping, equal-height strip (see `tileMetrics`),
 * so there is no fixed column count.
 */
export function galleryLayout(count: number): GalleryLayout {
  const visibleCount = Math.min(Math.max(count, 0), MAX_GALLERY_TILES);
  const overflow = Math.max(0, count - MAX_GALLERY_TILES);
  return { visibleCount, overflow };
}

export interface TileMetrics {
  /** Rendered tile width in px (height is always `TILE_HEIGHT`). */
  width: number;
  /** `contain` keeps the image whole (letterboxed within the tile); `cover`
   *  center-crops it — used only for images too wide to show whole at the cap. */
  fit: 'contain' | 'cover';
}

/**
 * Size one equal-height tile from an image's natural dimensions. The width is the
 * image's aspect ratio at `TILE_HEIGHT`, clamped to `[TILE_MIN_WIDTH,
 * TILE_MAX_WIDTH]`. Only images wider than the cap are center-cropped (`cover`);
 * everything else renders whole (`contain`), so the thumbnail matches what the
 * lightbox shows and the open/close morph stays true.
 */
export function tileMetrics(
  naturalW: number,
  naturalH: number,
  height = TILE_HEIGHT,
  minW = TILE_MIN_WIDTH,
  maxW = TILE_MAX_WIDTH,
): TileMetrics {
  // Degenerate/unknown dimensions: fall back to a min-width square-ish tile.
  if (!(naturalW > 0) || !(naturalH > 0)) return { width: minW, fit: 'contain' };
  const ideal = height * (naturalW / naturalH);
  const width = Math.round(Math.min(Math.max(ideal, minW), maxW));
  return { width, fit: ideal > maxW ? 'cover' : 'contain' };
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
