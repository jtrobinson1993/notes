import { describe, expect, it } from 'vitest';
import { clampOffset, coverScale, sourceRect } from '../../src/lib/avatar';

describe('avatar crop geometry', () => {
  it('coverScale fits the shorter side to the viewport', () => {
    // 800×400 into a 256 frame: shorter side (400) maps to 256.
    expect(coverScale(800, 400, 256)).toBeCloseTo(256 / 400);
    // Portrait: shorter side is the width.
    expect(coverScale(400, 800, 256)).toBeCloseTo(256 / 400);
  });

  it('clampOffset keeps the image covering the viewport (no gaps)', () => {
    // display 400 wide in a 256 frame → offset must be within [-144, 0].
    expect(clampOffset(50, 400, 256)).toBe(0); // can't expose left gap
    expect(clampOffset(-200, 400, 256)).toBe(-144); // can't expose right gap
    expect(clampOffset(-100, 400, 256)).toBe(-100); // valid offset passes through
  });

  it('clampOffset pins an exactly-covering image at 0', () => {
    expect(clampOffset(-5, 256, 256)).toBe(0);
  });

  it('sourceRect maps the viewport back to source pixels', () => {
    // No pan, 2× effective scale: the frame samples a 128px square at the origin.
    expect(sourceRect(0, 0, 2, 256)).toEqual({ sx: 0, sy: 0, size: 128 });
    // Panned left by 100 display px → source x shifts by 100/scale.
    expect(sourceRect(-100, -40, 2, 256)).toEqual({ sx: 50, sy: 20, size: 128 });
  });

  it('round-trips a centered crop: offset → source rect stays inside the image', () => {
    const natW = 800;
    const natH = 600;
    const viewport = 256;
    const scale = coverScale(natW, natH, viewport); // covers on height (600)
    const dispW = natW * scale;
    const ox = clampOffset((viewport - dispW) / 2, dispW, viewport); // centered
    const { sx, size } = sourceRect(ox, 0, scale, viewport);
    expect(sx).toBeGreaterThanOrEqual(0);
    expect(sx + size).toBeLessThanOrEqual(natW + 0.001);
  });
});
