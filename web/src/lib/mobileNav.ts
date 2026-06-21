import { ref } from 'vue';

// Mobile (phone) navigation. On desktop these are ignored (every pane renders
// side-by-side). On a phone the shell shows the narrow icon rail (the "main
// menu") beside an *intermediary* list — the chat's channel list or the notes
// list. Opening a *leaf* that should own the whole screen — a channel's
// messages or a single note — hides the rail for a full-screen view, with a
// back control that returns to the list (and the rail).
//
// The rail is never shown full-screen on its own, so there's no blank
// "menu only" landing state; the app restores your last route on launch.

/** Within a chat: the channel list (rail visible) vs a channel's messages
 *  (full screen). */
export type ChatPane = 'channels' | 'messages';
export const chatPane = ref<ChatPane>('channels');

/** Notes: whether a single note is open full-screen (rail hidden). Synced to the
 *  notes page's selection so the rail knows to step aside. */
export const noteOpen = ref(false);

export function showChannels(): void {
  chatPane.value = 'channels';
}
export function showMessages(): void {
  chatPane.value = 'messages';
}
export function closeNote(): void {
  noteOpen.value = false;
}

/** Reactive "the viewport is phone-sized" (< 768px). */
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 767px)') : null;
export const isMobile = ref(mq?.matches ?? false);
mq?.addEventListener('change', (e) => {
  isMobile.value = e.matches;
});
