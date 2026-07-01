import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { PiniaColada } from '@pinia/colada';
import App from './App.vue';
import { router } from './router';
import { initTheme } from './lib/theme';
import { trackViewportHeight } from './lib/viewport';
// Self-hosted fonts (bundled, no CDN call — same privacy posture as the icons):
// Geist Sans for UI/prose, Geist Mono for code. Both variable (all weights).
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';

initTheme();
trackViewportHeight();

const app = createApp(App);
app.use(createPinia());
app.use(PiniaColada, {});
app.use(router);
app.mount('#app');

// Soft-navigate when a push notification is clicked while the app is open: the
// service worker posts the deep-link path (built by pushTarget) and we route to
// it in-app, so the exact channel/thread + message open without a full reload.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: string } | null;
    if (d?.type === 'notification-navigate' && typeof d.url === 'string') {
      void router.push(d.url);
    }
  });
}
