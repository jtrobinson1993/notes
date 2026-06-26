# PWA & push notifications (v3 phase 3)

The app is an installable PWA (offline app shell via a service worker). Phase 3
adds **background Web Push** so a closed/backgrounded install still surfaces new
messages — without weakening the E2EE model.

Notifications span three surfaces: the **foreground chime** (app open, sound),
the **tab title + app-icon badge** (unread count, app open), and **background
Web Push** (app closed/backgrounded). The chime and badge run entirely client-
side off the live WebSocket; push is the fallback when no socket is connected.

## In-app chime (foreground)

When the app is open and a chat message arrives over the WebSocket that the user
**isn't actively looking at**, a short sound plays (`web/src/assets/message-
chime.mp3`, bundled by Vite and served same-origin — covered by the existing CSP
`media-src 'self'`). The decision is the pure `shouldChime` (`web/src/lib/
chime.ts`), called from the chat store's `message` frame handler: it chimes when
the message is **not from us** *and* either

- the app **isn't focused** — `isAppFocused()` is false (`document` hidden, or
  another window/tab/app has focus, via `visibilityState` + `document.hasFocus()`),
  **or**
- the message landed in a channel that **isn't the one currently open**
  (`activeChannelId` ≠ the message's channel).

So a message in the open, focused channel stays silent; anything else rings.
`playChime` is best-effort and **throttled** (one chime per 1.5s) so a burst or
backfill can't machine-gun the speaker; it's a silent no-op if the browser blocks
playback before a user gesture (the title/badge still update).

## Content-free by design

The server is crypto-oblivious: it stores only ciphertext and cannot read a
message. So a push **never carries plaintext**. The payload is only a routing
hint:

```json
{ "type": "message", "conversationId": "<id>", "channelId": "<id>", "seq": 42 }
```

The service worker shows a generic **"New message"** (never the text or the
sender's name). On click it builds the in-app path with the pure `pushTargetUrl`
(`lib/pushTarget.ts`) and **deep-links to the exact message**: the conversation,
the **channel** segment when it isn't the general channel, and `?m=<seq>` so the
client scrolls to and flashes that message. A **reply-thread** message routes to
the *parent* conversation with `threadParentSeq` → `?thread=<parentSeq>`, which
opens that thread's panel (the seq scrolls within it). The client connects and
decrypts as usual. This is the same posture as E2EE messengers like Signal — the
notification is a doorbell, not the message. All these fields are metadata the
server already routes on (it maps messages to members/channels), so the push
leaks nothing new.

The click prefers a **soft navigation**: an open tab is focused and the worker
`postMessage`s the path, which the app routes in-app (so it opens the channel,
the thread panel, and scrolls without a reload — and, on mobile, lands on the
**messages** pane rather than the channel list). With no open tab it cold-starts
at the deep link via `openWindow`.

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

**First-open prompt.** `NotificationOptIn.vue` (mounted in `App.vue` while
signed in) asks **once per device** whether to turn notifications on, then
records the choice in `localStorage` (`NOTIF_OPTIN_SEEN_KEY`,
`notes:notif-optin-seen`) so it never re-appears — whichever option is picked
(Enable, Not now, or dismiss). The pure `shouldOfferPush` gates it: only when the
platform supports push, the OS permission is still `default` (undecided), the
server has a VAPID key (push can actually be delivered), and the device hasn't
been asked before. **Enable** calls `enablePush` from the button click (a user
gesture, as browsers require for the permission request). The Settings toggle
remains the way to change the choice later.

## Requirements & limits

- **HTTPS only** — Web Push needs a secure context (localhost excepted for dev).
- Delivery is best-effort and platform-dependent (browser push services, OS
  battery policy). The WebSocket remains the primary, instant delivery path; push
  is the fallback for when the app isn't connected.
