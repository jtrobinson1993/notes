import { describe, expect, it } from 'vitest';
import { formatBytes, formatMime, nameForType } from '../../src/lib/fileMeta';

describe('formatBytes', () => {
  it('uses B / KB / MB by magnitude', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(45_000)).toBe('44 KB');
    expect(formatBytes(1_572_864)).toBe('1.5 MB');
  });
});

describe('formatMime', () => {
  it('takes the subtype, uppercased', () => {
    expect(formatMime('image/png')).toBe('PNG');
    expect(formatMime('image/jpeg')).toBe('JPEG');
  });

  it('strips `+suffix` and `x-` prefixes', () => {
    expect(formatMime('image/svg+xml')).toBe('SVG');
    expect(formatMime('image/x-icon')).toBe('ICON');
  });

  it('falls back to the raw string when there is no subtype', () => {
    expect(formatMime('weird')).toBe('WEIRD');
  });
});

describe('nameForType', () => {
  it('swaps the extension to match the optimized type', () => {
    expect(nameForType('DSCF3984.jpeg', 'image/webp')).toBe('DSCF3984.webp');
    expect(nameForType('photo.PNG', 'image/webp')).toBe('photo.webp');
  });

  it('only drops the final extension segment', () => {
    expect(nameForType('my.holiday.photo.jpg', 'image/webp')).toBe('my.holiday.photo.webp');
  });

  it('appends an extension when the name had none', () => {
    expect(nameForType('screenshot', 'image/webp')).toBe('screenshot.webp');
  });
});
