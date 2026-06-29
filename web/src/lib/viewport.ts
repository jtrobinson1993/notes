// Keeps the `--app-height` CSS custom property in sync with the *visual*
// viewport height — the area actually visible to the user, which shrinks when
// the mobile on-screen keyboard opens. This is the keyboard-fit path for iOS
// Safari, which ignores the viewport `interactive-widget` directive: there the
// keyboard overlays the page, `window.innerHeight` (and `100vh`) keep reporting
// the full layout viewport, and without this the chat composer ends up hidden
// behind the keyboard. The app shell uses `height: var(--app-height)` (see
// style.css) so it resizes to the visible region instead.
//
// Android Chrome instead honours `interactive-widget=resizes-content` (set in
// index.html), so the keyboard shrinks the *layout* viewport directly; there the
// visual viewport equals the layout viewport, so this tracking is a harmless
// no-op that matches `100%`. (The default `resizes-visual` left the layout
// viewport full-height while only the visual viewport shrank, so the shell was
// shorter than `body` — a tall blank strip and scrollable gap below it.)
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
    // iOS Safari scrolls the *document* to lift a focused input above the
    // keyboard. Because the shell is already sized to the visual viewport
    // (height above), the input is on-screen anyway, so that scroll only shoves
    // the whole app up by ~the keyboard height — stranding the user away from
    // where they were reading in the chat. The app shell never legitimately
    // scrolls the document (every pane scrolls its own overflow container), so
    // pin it back to the top; each pane then keeps its own scroll position.
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };

  update();
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
}
