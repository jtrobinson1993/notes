/**
 * Thin wrapper around the View Transitions API used for the chat image → modal
 * morph (`ChatAttachment.vue` / `ImageLightbox.vue`). Kept DOM-light and
 * dependency-injectable so the support/motion gating is unit-testable.
 */

interface ViewTransition {
  finished: Promise<unknown>;
}
type StartViewTransition = (cb: () => void | Promise<void>) => ViewTransition;

export interface ViewTransitionEnv {
  doc?: Document;
  win?: Window;
}

/** True when the browser supports view transitions and the user allows motion. */
export function viewTransitionsEnabled(env: ViewTransitionEnv = {}): boolean {
  const doc = env.doc ?? document;
  const win = env.win ?? window;
  const supported = typeof (doc as { startViewTransition?: unknown }).startViewTransition === 'function';
  const reduced = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  return supported && !reduced;
}

/**
 * Run `mutate` (the DOM/state change) inside a view transition when enabled,
 * otherwise just run it. Resolves once any animation finishes so callers can
 * clear transition-only state (e.g. the temporary `view-transition-name`).
 */
export async function withViewTransition(
  mutate: () => void | Promise<void>,
  env: ViewTransitionEnv = {},
): Promise<void> {
  if (!viewTransitionsEnabled(env)) {
    await mutate();
    return;
  }
  const start = (env.doc ?? document) as Document & { startViewTransition: StartViewTransition };
  const t = start.startViewTransition(() => mutate());
  try {
    await t.finished;
  } catch {
    // Transition skipped/aborted — the callback already applied the mutation.
  }
}
