// App-wide toasts. A tiny reactive queue rather than a store: toasts are pure
// UI ephemera with no persistence, and anything (a lib module, a store, a
// component) must be able to raise one without pulling in Pinia.
//
// Errors are raised by CATALOGUE CODE, not by free text — see lib/errors. That
// keeps the wording in one reviewable place and gives the user a code they can
// look up on the website.
import { ref } from 'vue';
import { errorEntry } from './errors';

export type ToastKind = 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  /** The sentence shown to the user. */
  message: string;
  /** Catalogue code, when this came from a catalogued error. */
  code?: string;
  /** First step from the catalogue, shown as a hint under the message. */
  hint?: string;
}

export const toasts = ref<Toast[]>([]);

// Errors linger long enough to read a two-line message; info is quicker.
const DISMISS_MS: Record<ToastKind, number> = { error: 9000, info: 4000 };

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function push(t: Omit<Toast, 'id'>): number {
  const id = nextId++;
  toasts.value = [...toasts.value, { ...t, id }];
  timers.set(
    id,
    setTimeout(() => dismissToast(id), DISMISS_MS[t.kind]),
  );
  return id;
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

/**
 * Show a catalogued error. Unknown codes still surface (as the bare code) —
 * a missing catalogue entry is a docs bug and must not swallow the failure.
 */
export function toastError(code: string): number {
  const entry = errorEntry(code);
  return push({
    kind: 'error',
    code,
    message: entry?.readableName ?? code,
    hint: entry?.stepsToFix[0],
  });
}

/** Show a plain informational message (no catalogue entry needed). */
export function toastInfo(message: string): number {
  return push({ kind: 'info', message });
}

/** Test hook: clear the queue and every pending timer. */
export function resetToasts(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  toasts.value = [];
}
