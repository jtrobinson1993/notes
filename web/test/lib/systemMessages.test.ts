import { describe, expect, it } from 'vitest';
import { JOIN_PHRASES, joinText, randomJoinPhrase } from '../../src/lib/systemMessages';

describe('joinText', () => {
  it('substitutes the name into the chosen phrase', () => {
    expect(joinText('Alice', 0)).toBe('Alice joined the chat.');
    expect(joinText('Bob', 5)).toBe('A wild Bob appeared!');
  });

  it('falls back to the plain phrase for an out-of-range index', () => {
    expect(joinText('Cara', 999)).toBe('Cara joined the chat.');
    expect(joinText('Cara', -1)).toBe('Cara joined the chat.');
  });

  it('every phrase contains the name placeholder', () => {
    for (const p of JOIN_PHRASES) expect(p).toContain('{name}');
  });
});

describe('randomJoinPhrase', () => {
  it('always returns a valid index', () => {
    for (let i = 0; i < 50; i++) {
      const n = randomJoinPhrase();
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(JOIN_PHRASES.length);
    }
  });
});
