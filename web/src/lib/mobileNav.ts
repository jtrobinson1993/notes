import { ref } from 'vue';

// Mobile (phone) navigation state. On desktop every pane renders side-by-side and
// these are ignored; on a phone we show one full-screen pane at a time with a
// back stack. `< md` (768px) is "mobile", matching Tailwind's md breakpoint.

export type MobilePane = 'list' | 'channels' | 'messages';

/** Which chat pane is showing on mobile: the chat list, a chat's channel list,
 *  or a channel's messages. */
export const mobilePane = ref<MobilePane>('list');
export function showChatList(): void {
  mobilePane.value = 'list';
}
export function showChannels(): void {
  mobilePane.value = 'channels';
}
export function showMessages(): void {
  mobilePane.value = 'messages';
}

/** Reactive "the viewport is phone-sized" (< 768px). */
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 767px)') : null;
export const isMobile = ref(mq?.matches ?? false);
mq?.addEventListener('change', (e) => {
  isMobile.value = e.matches;
});
