// New-message chime: a short sound played when a chat message arrives that the
// user isn't actively looking at. Vite hashes/bundles the asset; it's served
// same-origin, so CSP `media-src 'self'` covers it.
import chimeUrl from '../assets/message-chime.mp3';

// Bursts of messages (e.g. a backfill or a fast sender) shouldn't machine-gun
// the speaker — collapse anything within this window into a single chime.
const MIN_GAP_MS = 1500;

let el: HTMLAudioElement | null = null;
let lastPlayed = 0;

/** Is the app the user's current focus? False when the tab is backgrounded or
 *  another window/tab/app has focus — i.e. when a chime is warranted. */
export function isAppFocused(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** Decide whether an incoming message should ring the chime. Chime when the
 *  message is from someone else AND the user isn't looking at it — either the
 *  app isn't focused, or the message landed in a channel that isn't the one
 *  currently open. */
export function shouldChime(opts: { fromMe: boolean; channelOpen: boolean; focused: boolean }): boolean {
  if (opts.fromMe) return false;
  return !opts.focused || !opts.channelOpen;
}

/** Play the chime, best-effort. Throttled, and silently a no-op if the browser
 *  blocks playback before a user gesture (the unread badge/title still update). */
export function playChime(): void {
  const now = Date.now();
  if (now - lastPlayed < MIN_GAP_MS) return;
  lastPlayed = now;
  try {
    if (!el) {
      el = new Audio(chimeUrl);
      el.preload = 'auto';
    }
    el.currentTime = 0;
    void el.play()?.catch(() => {
      /* autoplay blocked until the user interacts with the page */
    });
  } catch {
    /* Audio unsupported in this environment */
  }
}
