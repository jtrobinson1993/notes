// Keeps the `--app-height` CSS custom property in sync with the *visual*
// viewport height — the area actually visible to the user, which shrinks when
// the mobile on-screen keyboard opens. `window.innerHeight` (and `100vh`) keep
// reporting the full layout viewport, so without this the chat composer ends up
// hidden behind the keyboard. The app shell uses `height: var(--app-height)`
// (see style.css) so it resizes to the visible region instead.
//
// We deliberately set height only (not a transform): a transform on the app
// root would establish a containing block and break `position: fixed` modals,
// lightbox, and toasts. Sizing the shell to the visible height means the focused
// composer is already on-screen, so the browser has no reason to scroll the page
// (offsetTop stays ~0) and a transform isn't needed.
export function trackViewportHeight(): void {
  if (typeof window === 'undefined') return;
  const root = document.documentElement;
  const vv = window.visualViewport;

  const update = (): void => {
    const h = vv?.height ?? window.innerHeight;
    root.style.setProperty('--app-height', `${Math.round(h)}px`);
  };

  update();
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
}
