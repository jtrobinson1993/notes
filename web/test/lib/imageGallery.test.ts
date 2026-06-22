import { describe, expect, it } from 'vitest';
import { galleryLayout, MAX_GALLERY_TILES, stepIndex } from '../../src/lib/imageGallery';

describe('galleryLayout', () => {
  it('renders a lone image on its own with no overflow', () => {
    expect(galleryLayout(1)).toEqual({ visibleCount: 1, overflow: 0, cols: 1 });
  });

  it('tiles 2 and 4 images in two columns', () => {
    expect(galleryLayout(2)).toMatchObject({ cols: 2, visibleCount: 2, overflow: 0 });
    expect(galleryLayout(4)).toMatchObject({ cols: 2, visibleCount: 4, overflow: 0 });
  });

  it('tiles 3 and 5 images in three columns', () => {
    expect(galleryLayout(3)).toMatchObject({ cols: 3, visibleCount: 3 });
    expect(galleryLayout(5)).toMatchObject({ cols: 3, visibleCount: 5, overflow: 0 });
  });

  it('caps visible tiles and reports the remainder as overflow past the cap', () => {
    // 8 images → show 5, the 5th carries a "+3" badge.
    expect(galleryLayout(8)).toMatchObject({ visibleCount: MAX_GALLERY_TILES, overflow: 3 });
    expect(galleryLayout(6).overflow).toBe(1);
  });

  it('never shows negative overflow', () => {
    expect(galleryLayout(0).overflow).toBe(0);
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
