// Typed access to the user-facing error catalogue (catalog.json).
//
// The catalogue is the single source of truth for every error a user can be
// shown: the app renders `readableName` in a toast, and the website publishes
// the full entry (cause + steps to fix) at a stable per-code URL so someone who
// hits the message can look it up. Adding a code here is part of adding a
// user-visible failure — see CLAUDE.md.
import catalog from './catalog.json';

export interface ErrorEntry {
  /** Short, human sentence — what the toast shows. Never a raw code. */
  readableName: string;
  /** What happened, in plain language. */
  description: string;
  /** Why it happened, including the tradeoff we chose on the user's behalf. */
  cause: string;
  /** Ordered, concrete things the user can try. */
  stepsToFix: string[];
}

// `$comment` documents the file for humans reading the JSON; it is not an error.
const { $comment: _doc, ...entries } = catalog as Record<string, unknown> & { $comment?: string };

export const errorCatalog = entries as unknown as Record<string, ErrorEntry>;

/** Every code in the catalogue. */
export type ErrorCode = keyof typeof catalog extends infer K
  ? K extends '$comment'
    ? never
    : K
  : never;

/** Look up an entry, or undefined for an unknown code. */
export function errorEntry(code: string): ErrorEntry | undefined {
  return errorCatalog[code];
}

/**
 * The sentence to show a user for `code`. Falls back to the code itself rather
 * than throwing: a missing catalogue entry is a documentation bug, and it must
 * never turn a handled failure into an unhandled one.
 */
export function errorMessage(code: string): string {
  return errorEntry(code)?.readableName ?? code;
}
