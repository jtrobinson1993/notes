// Public-handle generation + validation. The word list, `randomHandle`, and
// `isValidHandle` are shared with the native client (@notes/shared) so both draw
// from the same vetted list; the uniqueness-checked generator below stays here
// because it needs the server's DB.
import { randomHandle } from '@notes/shared';

export { HANDLE_WORDS, randomHandle, isValidHandle, generateHandleOptions } from '@notes/shared';

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
