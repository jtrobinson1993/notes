import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ChatAvatar from '../../src/components/ChatAvatar.vue';

describe('ChatAvatar', () => {
  it('shows the uppercase first letter of the display name', () => {
    expect(mount(ChatAvatar, { props: { name: 'alice' } }).text()).toBe('A');
    expect(mount(ChatAvatar, { props: { name: 'Bob' } }).text()).toBe('B');
  });

  it('falls back to "?" for an empty/blank name', () => {
    expect(mount(ChatAvatar, { props: { name: '   ' } }).text()).toBe('?');
  });

  it('applies a background color, deterministic per seed', () => {
    const a = mount(ChatAvatar, { props: { name: 'X', seed: 'user-1' } });
    const b = mount(ChatAvatar, { props: { name: 'Y', seed: 'user-1' } });
    expect(a.attributes('style')).toMatch(/background-color/);
    // Same seed → same color, regardless of the letter shown.
    expect(b.attributes('style')).toBe(a.attributes('style'));
  });

  it('varies the color by seed across users', () => {
    const colors = new Set(
      Array.from({ length: 10 }, (_, i) =>
        mount(ChatAvatar, { props: { name: 'A', seed: `user-${i}` } }).attributes('style'),
      ),
    );
    expect(colors.size).toBeGreaterThan(1);
  });
});
