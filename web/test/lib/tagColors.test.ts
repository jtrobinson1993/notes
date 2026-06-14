import { describe, expect, it } from 'vitest';
import { clearTagColor, setTagColor, tagColor, tagTextColor } from '../../src/lib/tagColors';

describe('tagColor (preset hashing)', () => {
  it('is deterministic for a given tag name', () => {
    expect(tagColor('work')).toBe(tagColor('work'));
    expect(tagColor('work')).toBeTruthy();
  });

  it('honours an explicitly set color and reverts on clear', () => {
    const tag = 'tagcolors-test-explicit';
    const preset = tagColor(tag);
    setTagColor(tag, '#123456');
    expect(tagColor(tag)).toBe('#123456');
    clearTagColor(tag);
    expect(tagColor(tag)).toBe(preset);
  });
});

describe('tagTextColor (WCAG luminance pick)', () => {
  it('uses black text on a light background', () => {
    expect(tagTextColor('#ffffff')).toBe('#000');
    expect(tagTextColor('#ffff00')).toBe('#000'); // bright yellow
  });

  it('uses white text on a dark background', () => {
    expect(tagTextColor('#000000')).toBe('#fff');
    expect(tagTextColor('#0000ff')).toBe('#fff'); // deep blue
  });

  it('falls back to white text when the color cannot be resolved to a hex', () => {
    expect(tagTextColor('not-a-color')).toBe('#fff');
  });
});
