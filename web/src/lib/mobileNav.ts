import { ref } from 'vue';

// Mobile (phone) navigation. On desktop these are ignored (every pane renders
// side-by-side). On a phone we show one full-screen pane at a time with a back
// stack; `< md` (768px) is "mobile".
//
// The app sidebar is the mobile "home" (chat list + nav). When `homeOpen` is
// true it fills the screen and the current page is hidden; tapping a chat / Notes
// / Settings / Friends opens that page full-screen (`homeOpen = false`), and each
// page has a back button that returns home (`goHome`).

export const homeOpen = ref(true);

/** Within a chat: the channel list vs a channel's messages. */
export type ChatPane = 'channels' | 'messages';
export const chatPane = ref<ChatPane>('channels');

export function goHome(): void {
  homeOpen.value = true;
}
/** Open a non-chat page (Notes/Settings/Friends) full-screen. */
export function openPage(): void {
  homeOpen.value = false;
}
export function showChannels(): void {
  homeOpen.value = false;
  chatPane.value = 'channels';
}
export function showMessages(): void {
  homeOpen.value = false;
  chatPane.value = 'messages';
}

/** Reactive "the viewport is phone-sized" (< 768px). */
const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 767px)') : null;
export const isMobile = ref(mq?.matches ?? false);
mq?.addEventListener('change', (e) => {
  isMobile.value = e.matches;
});
