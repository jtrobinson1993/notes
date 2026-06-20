import { HANDLE_WORDS } from './handleWords.js';

// Public handles like "Otter#0421": a curated animal/nature word + a 4-digit
// discriminator. The handle is the only identifier shown to people who aren't
// your contacts (and the only name the server can read) — your real display
// name is end-to-end encrypted and shared only with contacts.

const WORD_SET = new Set(HANDLE_WORDS);
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** A random candidate handle, e.g. "Otter#0421" (not checked for uniqueness). */
export function randomHandle(): string {
  const word = HANDLE_WORDS[Math.floor(Math.random() * HANDLE_WORDS.length)]!;
  const num = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0');
  return `${cap(word)}#${num}`;
}

/** Generate up to `count` distinct handles that pass `isTaken === false`. */
export function generateUniqueHandles(count: number, isTaken: (h: string) => boolean): string[] {
  const out = new Set<string>();
  // Bounded retries so a near-exhausted namespace can't spin forever.
  for (let guard = 0; out.size < count && guard < count * 1000; guard++) {
    const h = randomHandle();
    if (!isTaken(h)) out.add(h);
  }
  return [...out];
}

/** A well-formed handle: "Capitalized#1234" where the word is from our list. */
export function isValidHandle(h: unknown): h is string {
  if (typeof h !== 'string') return false;
  const m = /^([A-Z][a-z]+)#(\d{4})$/.exec(h);
  return !!m && WORD_SET.has(m[1]!.toLowerCase());
}
