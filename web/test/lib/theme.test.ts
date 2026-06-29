import { beforeEach, describe, expect, it } from 'vitest';
import { getPalette, getTheme, setPalette, setTheme } from '../../src/lib/theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
  delete document.documentElement.dataset.theme;
  document.head.querySelector('meta[name="theme-color"]')?.remove();
  document.body.removeAttribute('style');
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

describe('theme-color meta (status-bar / notch chrome)', () => {
  it('syncs the meta to the resolved page background on a theme change', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', '#fafafa');
    document.head.appendChild(meta);
    // jsdom's getComputedStyle reflects inline styles, standing in for the
    // theme's body background.
    document.body.style.backgroundColor = 'rgb(9, 9, 11)';

    setTheme('dark');
    expect(meta.getAttribute('content')).toBe('rgb(9, 9, 11)');
  });

  it('leaves the pre-paint value untouched when the background is transparent', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', '#fafafa');
    document.head.appendChild(meta);
    // No background applied yet (stylesheet not loaded) → transparent.

    setPalette('pastel');
    expect(meta.getAttribute('content')).toBe('#fafafa');
  });
});
