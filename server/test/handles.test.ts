import { describe, expect, it } from 'vitest';
import { generateUniqueHandles, isValidHandle, randomHandle } from '../src/handles.js';
import { HANDLE_WORDS } from '../src/handleWords.js';

const WORD_SET = new Set(HANDLE_WORDS);

describe('handle word list', () => {
  it('is non-trivial, unique, and within 3–10 lowercase chars', () => {
    expect(HANDLE_WORDS.length).toBeGreaterThan(200);
    expect(new Set(HANDLE_WORDS).size).toBe(HANDLE_WORDS.length); // no duplicates
    for (const w of HANDLE_WORDS) {
      expect(w).toMatch(/^[a-z]{3,10}$/);
    }
  });
});

describe('randomHandle', () => {
  it('always produces a valid "Word#1234" from the list', () => {
    for (let i = 0; i < 500; i++) {
      const h = randomHandle();
      const m = /^([A-Z][a-z]+)#(\d{4})$/.exec(h);
      expect(m, h).not.toBeNull();
      expect(WORD_SET.has(m![1]!.toLowerCase())).toBe(true);
    }
  });
});

describe('isValidHandle', () => {
  it('accepts a well-formed handle whose word is in the list', () => {
    const word = HANDLE_WORDS[0]!;
    const cap = word[0]!.toUpperCase() + word.slice(1);
    expect(isValidHandle(`${cap}#0001`)).toBe(true);
  });
  it('rejects bad format, wrong case, non-list words, and non-strings', () => {
    expect(isValidHandle('Otter#12')).toBe(false); // too few digits
    expect(isValidHandle('Otter#12345')).toBe(false); // too many digits
    expect(isValidHandle('otter#1234')).toBe(false); // not capitalized
    expect(isValidHandle('Zzzzzz#1234')).toBe(false); // not in the list
    expect(isValidHandle('Otter1234')).toBe(false); // missing #
    expect(isValidHandle(42)).toBe(false);
    expect(isValidHandle(null)).toBe(false);
  });
});

describe('generateUniqueHandles', () => {
  it('returns the requested count, all distinct and not "taken"', () => {
    const taken = new Set(['Otter#0001']);
    const out = generateUniqueHandles(5, (h) => taken.has(h));
    expect(out).toHaveLength(5);
    expect(new Set(out).size).toBe(5);
    for (const h of out) expect(taken.has(h)).toBe(false);
  });
  it('never yields a handle the predicate marks taken', () => {
    // Treat everything as taken → it can return nothing, but never a "taken" one.
    const out = generateUniqueHandles(3, () => true);
    expect(out).toEqual([]);
  });
});
