/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL, cleanupOutdatedCaches, type PrecacheEntry } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { clientsClaim } from 'workbox-core';
import type { PushPayload } from '@notes/shared';
import { pushTargetUrl } from './lib/pushTarget';

// Custom service worker (vite-plugin-pwa `injectManifest` strategy). It keeps the
// previous precaching/emoji behavior AND adds Web Push handlers — which the
// default generated worker can't host. Pushes are content-free (see push.ts):
// we only ever show "New message" and deep-link on click; the app decrypts.

// workbox-build injects the precache manifest by textually replacing the literal
// `self.__WB_MANIFEST`, so that token must appear verbatim below. Type it via a
// globalThis augmentation (self is `… & typeof globalThis` under our lib config).
declare global {
  // eslint-disable-next-line no-var
  var __WB_MANIFEST: Array<PrecacheEntry | string>;
}

// `self` is typed as the DOM Window here; alias it to the worker scope for the
// typed worker API (events, registration, clients) without redeclaring it.
const sw = self as unknown as ServiceWorkerGlobalScope;

// registerType:'autoUpdate' — take over as soon as the new worker installs.
void sw.skipWaiting();
clientsClaim();

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// SPA navigations fall back to the precached app shell, except API/emoji paths.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//, /^\/emoji\//],
  }),
);

// Default 7TV emoji set: hundreds of tiny immutable files, cached on demand
// rather than precached (mirrors the prior workbox runtimeCaching config).
registerRoute(
  ({ url }) => url.pathname.startsWith('/emoji/'),
  new CacheFirst({
    cacheName: 'emoji',
    plugins: [new ExpirationPlugin({ maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 30 })],
  }),
);

// ---- Web Push ----
sw.addEventListener('push', (event) => {
  let data: Partial<PushPayload> = {};
  try {
    data = (event.data?.json() as Partial<PushPayload>) ?? {};
  } catch {
    /* a contentless push — still show a generic notification */
  }
  const conversationId = data.type === 'message' ? data.conversationId : undefined;
  event.waitUntil(
    sw.registration.showNotification('Accord', {
      body: 'New message',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Collapse repeated pings for the same conversation into one notification.
      tag: conversationId ? `conv:${conversationId}` : 'accord',
      // Keep the whole routing payload so the click can open the exact channel /
      // thread message (built into a path by the shared `pushTargetUrl`).
      data,
    }),
  );
});

sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const payload = event.notification.data as Partial<PushPayload> | null;
  const target = pushTargetUrl(payload);
  event.waitUntil(
    (async () => {
      const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        // Focus an existing tab and ask the app to soft-navigate (so it can open
        // the channel, the thread panel, and scroll to the message without a full
        // reload). The app listens for this in main.ts.
        await client.focus();
        client.postMessage({ type: 'notification-navigate', url: target });
        return;
      }
      // No open tab: cold-start at the deep link (the app reads it on load).
      await sw.clients.openWindow(target);
    })(),
  );
});
