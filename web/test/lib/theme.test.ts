import { beforeEach, describe, expect, it } from 'vitest';
import { getPalette, getTheme, setPalette, setTheme } from '../../src/lib/theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
});

describe('theme mode', () => {
  it('defaults to system and persists explicit choices', () => {
    expect(getTheme()).toBe('system');
    setTheme('dark');
    expect(getTheme()).toBe('dark');
    expect(localStorage.getItem('notes:theme')).toBe('dark');
  });

  it('toggles the .dark class on for dark and off for light', () => {
    setTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    setTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('ignores an invalid stored value, falling back to system', () => {
    localStorage.setItem('notes:theme', 'bogus');
    expect(getTheme()).toBe('system');
  });
});

describe('palette', () => {
  it('defaults to brand and persists valid palettes via data-theme', () => {
    expect(getPalette()).toBe('brand');
    setPalette('pastel');
    expect(getPalette()).toBe('pastel');
    expect(document.documentElement.dataset.theme).toBe('pastel');
    setPalette('high-contrast');
    expect(document.documentElement.dataset.theme).toBe('high-contrast');
  });

  it('rejects an unknown palette value', () => {
    localStorage.setItem('notes:palette', 'neon');
    expect(getPalette()).toBe('brand');
  });
});
