import { describe, expect, it } from 'vitest';
import {
  CLICK_ZOOM,
  MAX_SCALE,
  MIN_SCALE,
  clampPan,
  clampScale,
  zoomToPoint,
} from '../../src/lib/imageZoom';

describe('zoomToPoint', () => {
  it('keeps the centre fixed when zooming at the centre', () => {
    expect(zoomToPoint({ x: 0, y: 0 }, 1, CLICK_ZOOM, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('shifts pan so the cursor point stays under the cursor (zoom in)', () => {
    // Click 100px right of centre, zoom 1→2: point drifts +100px right, so we
    // translate -100px to pin it.
    expect(zoomToPoint({ x: 0, y: 0 }, 1, 2, { x: 100, y: 0 })).toEqual({ x: -100, y: 0 });
  });

  it('zooms out about the cursor (negative scale step)', () => {
    // Click 100px right of centre, zoom 2→1: image shrinks toward its centre,
    // so the point drifts 50px left; translate +50px to keep it under the cursor.
    expect(zoomToPoint({ x: 0, y: 0 }, 2, 1, { x: 100, y: 0 })).toEqual({ x: 50, y: 0 });
  });
});

describe('clampPan', () => {
  it('pins pan to zero at fit scale (no overflow to pan into)', () => {
    expect(clampPan({ x: 50, y: -30 }, 1, 800, 600)).toEqual({ x: 0, y: 0 });
  });

  it('allows pan up to half the overflow per side', () => {
    // scale 2, 800px wide → overflow 800px total → 400px per side.
    expect(clampPan({ x: 1000, y: -1000 }, 2, 800, 600)).toEqual({ x: 400, y: -300 });
    expect(clampPan({ x: 100, y: 50 }, 2, 800, 600)).toEqual({ x: 100, y: 50 });
  });
});

describe('clampScale', () => {
  it('clamps into [MIN_SCALE, MAX_SCALE]', () => {
    expect(clampScale(0.2)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(2)).toBe(2);
  });
});
