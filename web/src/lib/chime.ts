// New-message chime: a short sound played when a chat message arrives that the
// user isn't actively looking at. Vite hashes/bundles the asset; it's served
// same-origin, so CSP `media-src 'self'` covers it.
import chimeUrl from '../assets/message-chime.mp3';

// After a conversation chimes it goes quiet until the user reads it OR this long
// passes — whichever comes first. A per-conversation cooldown (rather than a
// global timer) keeps a busy or ignored conversation from machine-gunning the
// speaker, while still re-alerting once you've caught up or after a quiet gap.
export const CONV_MUTE_MS = 10_000;

let el: HTMLAudioElement | null = null;

/** Per-conversation chime suppression: conversationId → epoch-ms the mute lifts. */
export interface ChimeGate {
  mutedUntil: Map<string, number>;
}

// Module-level gate for the live app; tests drive the pure functions directly.
const gate: ChimeGate = { mutedUntil: new Map() };

/** Is the app the user's current focus? False when the tab is backgrounded or
 *  another window/tab/app has focus — i.e. when a chime is warranted. */
export function isAppFocused(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** Pure "does this message deserve attention" check, ignoring the cooldown:
 *  true when it isn't our own message AND we aren't already looking at it (the
 *  app is unfocused, or a different channel is open). */
export function shouldChime(opts: { fromMe: boolean; channelOpen: boolean; focused: boolean }): boolean {
  if (opts.fromMe) return false;
  return !opts.focused || !opts.channelOpen;
}

/** Pure cooldown gate (mutates `g`): chime when the message deserves attention
 *  AND the conversation isn't in its post-chime mute window. Records a fresh
 *  mute when it returns true. */
export function gateChime(
  g: ChimeGate,
  opts: { conversationId: string; fromMe: boolean; channelOpen: boolean; focused: boolean; now: number },
): boolean {
  if (!shouldChime(opts)) return false;
  const until = g.mutedUntil.get(opts.conversationId);
  if (until != null && opts.now < until) return false; // still muted
  g.mutedUntil.set(opts.conversationId, opts.now + CONV_MUTE_MS);
  return true;
}

/** Lift a conversation's mute (the user read/caught up on it) so its next new
 *  message alerts again. */
export function clearChimeMute(g: ChimeGate, conversationId: string): void {
  g.mutedUntil.delete(conversationId);
}

/** Play the chime, best-effort. A no-op if the browser blocks playback before a
 *  user gesture (the unread badge/title still update). Simultaneous chimes share
 *  one element, so a multi-conversation burst collapses to a single sound. */
export function playChime(): void {
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

/** Live-app entry point: ring for an incoming message unless it's our own,
 *  already on-screen, or within the conversation's post-chime mute window. */
export function maybeChime(opts: { conversationId: string; fromMe: boolean; channelOpen: boolean }): void {
  if (gateChime(gate, { ...opts, focused: isAppFocused(), now: Date.now() })) playChime();
}

/** The conversation was read — lift its mute so the next message alerts. */
export function noteConversationRead(conversationId: string): void {
  clearChimeMute(gate, conversationId);
}

/** Drop all per-conversation mutes (e.g. on logout / store reset). */
export function resetChimeMutes(): void {
  gate.mutedUntil.clear();
}
