# PWA & push notifications (v3 phase 3)

The app is an installable PWA (offline app shell via a service worker). Phase 3
adds **background Web Push** so a closed/backgrounded install still surfaces new
messages — without weakening the E2EE model.

## Content-free by design

The server is crypto-oblivious: it stores only ciphertext and cannot read a
message. So a push **never carries plaintext**. The payload is only a routing
hint:

```json
{ "type": "message", "conversationId": "<id>" }
```

The service worker shows a generic **"New message"** (never the text or the
sender's name), and on click focuses an open tab / opens the app at
`/chat/:conversationId`, where the client connects and decrypts as usual. This is
the same posture as E2EE messengers like Signal — the notification is a doorbell,
not the message. `conversationId` is metadata the server already routes on (it
maps messages to members), so the push leaks nothing new.

## Service worker

`web/src/sw.ts`, built via vite-plugin-pwa's **`injectManifest`** strategy (the
default *generated* worker can't host custom `push`/`notificationclick`
handlers). It keeps the prior behavior — precache of the app shell + on-demand
`CacheFirst` cache for the default 7TV emoji set (kept out of the precache) — and
adds the two push handlers. `registerType: 'autoUpdate'` (skipWaiting +
clientsClaim) so a new worker takes over immediately.

## Server

- **VAPID keys** (`server/src/push.ts`): from `VAPID_PUBLIC_KEY` /
  `VAPID_PRIVATE_KEY` (+ optional `VAPID_SUBJECT`) if set, else generated once on
  first boot and persisted to `DATA_DIR/vapid.json` so existing client
  subscriptions survive restarts. Push is disabled (a no-op) only if exactly one
  half of an explicit keypair is configured.
- **Subscriptions** (`push_subscriptions` table, one row per user+endpoint):
  `POST /api/push/subscribe` (https-only endpoint, upserted) and
  `POST /api/push/unsubscribe`; `GET /api/push/key` returns the VAPID public key
  the browser needs. All require auth.
- **Trigger:** when a message is posted, after the realtime fan-out the server
  pushes to every member **without a live socket** (`realtime.isOnline` false) —
  a connected client already received it over the WebSocket. The sender is
  skipped. A subscription the push service reports as gone (`404`/`410`) is
  pruned.

## Client

`web/src/lib/push.ts` wraps the browser Push API: `enablePush` requests
permission, subscribes with the VAPID key, and registers the subscription with
the server; `disablePush` unsubscribes locally and tells the server to forget the
endpoint; `pushState` reports `unsupported` / `denied` / `off` / `on`. The opt-in
lives in **Settings → Security → Notifications**, with copy that states the
content-free posture. Everything degrades gracefully where the Push API is
unavailable (e.g. a non-installed iOS context).

## Requirements & limits

- **HTTPS only** — Web Push needs a secure context (localhost excepted for dev).
- Delivery is best-effort and platform-dependent (browser push services, OS
  battery policy). The WebSocket remains the primary, instant delivery path; push
  is the fallback for when the app isn't connected.
