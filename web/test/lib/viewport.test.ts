import { afterEach, describe, expect, it } from 'vitest';
import { trackViewportHeight } from '../../src/lib/viewport';

afterEach(() => {
  document.documentElement.style.removeProperty('--app-height');
});

describe('trackViewportHeight', () => {
  it('sets --app-height from the viewport height immediately', () => {
    // jsdom has no visualViewport, so it falls back to window.innerHeight.
    Object.defineProperty(window, 'innerHeight', { value: 640, configurable: true });
    trackViewportHeight();
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('640px');
  });

  it('updates --app-height when the viewport resizes (keyboard opens)', () => {
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    trackViewportHeight();
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('800px');

    // Simulate the on-screen keyboard shrinking the visible area.
    Object.defineProperty(window, 'innerHeight', { value: 420, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue('--app-height')).toBe('420px');
  });
});
