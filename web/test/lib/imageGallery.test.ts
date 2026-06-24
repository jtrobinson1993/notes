import { describe, expect, it } from 'vitest';
import {
  galleryLayout,
  MAX_GALLERY_TILES,
  stepIndex,
  tileMetrics,
  TILE_HEIGHT,
  TILE_MAX_WIDTH,
  TILE_MIN_WIDTH,
} from '../../src/lib/imageGallery';

describe('galleryLayout', () => {
  it('shows every image inline when at or under the cap', () => {
    expect(galleryLayout(1)).toEqual({ visibleCount: 1, overflow: 0 });
    expect(galleryLayout(4)).toEqual({ visibleCount: MAX_GALLERY_TILES, overflow: 0 });
  });

  it('caps visible tiles and reports the remainder as overflow past the cap', () => {
    // 6 images → show 4, the 4th carries a "+2" badge.
    expect(galleryLayout(6)).toEqual({ visibleCount: MAX_GALLERY_TILES, overflow: 2 });
    expect(galleryLayout(5).overflow).toBe(1);
  });

  it('never shows negative counts or overflow', () => {
    expect(galleryLayout(0)).toEqual({ visibleCount: 0, overflow: 0 });
  });
});

describe('tileMetrics', () => {
  it('sizes width from the aspect ratio at the shared height, shown whole', () => {
    const m = tileMetrics(800, 600); // 4:3 → 160 * 4/3 ≈ 213, within [min,max]
    expect(m).toEqual({ width: Math.round(TILE_HEIGHT * (800 / 600)), fit: 'contain' });
  });

  it('letterboxes very tall/narrow images to the minimum width', () => {
    const m = tileMetrics(200, 1000); // ideal 32px → floored to min, kept whole
    expect(m).toEqual({ width: TILE_MIN_WIDTH, fit: 'contain' });
  });

  it('center-crops only images too wide to show whole at the cap', () => {
    const m = tileMetrics(4000, 500); // ideal 1280px → capped + cropped
    expect(m).toEqual({ width: TILE_MAX_WIDTH, fit: 'cover' });
  });

  it('falls back to a min-width contain tile for unknown dimensions', () => {
    expect(tileMetrics(0, 0)).toEqual({ width: TILE_MIN_WIDTH, fit: 'contain' });
  });
});

describe('stepIndex', () => {
  it('moves forward and back within bounds', () => {
    expect(stepIndex(0, 1, 4)).toBe(1);
    expect(stepIndex(2, -1, 4)).toBe(1);
  });

  it('clamps at both ends rather than wrapping', () => {
    expect(stepIndex(0, -1, 4)).toBe(0);
    expect(stepIndex(3, 1, 4)).toBe(3);
  });

  it('is a no-op for an empty list', () => {
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});
