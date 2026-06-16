import { describe, expect, it } from 'vitest';
import { formatBytes, formatMime } from '../../src/lib/fileMeta';

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
