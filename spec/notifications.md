# Notifications, toasts & the error catalogue

> **Status: as built** — and much of this file is a statement of what does *not*
> exist. The Web Push client is **gone**: the service worker (`web/src/sw.ts`),
> `lib/push.ts`, `lib/pushTarget.ts`, `lib/chime.ts`, the `NotificationOptIn`
> prompt and the app-icon badge were deleted with browser mode. (The `VitePWA`
> block in `web/vite.config.ts` is a leftover — it is disabled for Tauri builds
> and its `injectManifest` still points at the deleted `sw.ts`, so it is dead
> configuration, not a shipped PWA; `main.ts` likewise still carries a
> `serviceWorker` message listener with no worker to talk to.) The native shell
> raises **no OS-level notification at all** today: no banner, no sound, no
> dock/taskbar badge. The relay still has working content-free push plumbing,
> but **no client registers a subscription**, so that path is unreachable end to
> end (see below).

## What the app actually does today

| Surface | State |
|---|---|
| **Unread count in the window title** | Built — `App.vue` sums `nativeConversations` unread into `(n) Accord`, capped at `99+`. |
| **Per-conversation unread badges** | Built — in the side rail and the conversation list, from the core's `conversation_activity` ([chat.md](chat.md)). |
| **In-app toasts** | Built — `lib/toast.ts` + `AppToasts.vue` (below). |
| **OS notification when backgrounded/closed** | **Not built.** |
| **Sound on a new message** | **Not built** (the chime and its per-conversation cooldown/global-floor gating went with browser mode). |
| **Incoming voice call** | Rings **only while the app is running and connected**: the ring is a drained `call-offer` envelope surfaced in the in-app call panel ([voice.md](voice.md)). A closed app misses the call entirely. |

Unread itself is **local and private**: the read marker is
`conversations.last_read_ts` in the encrypted store, never sent anywhere. There
are no read receipts and no delivery receipts — adding either would put
per-message timing metadata on the relay.

## In-app toasts (as built)

`web/src/lib/toast.ts` is a **reactive queue, not a Pinia store**, deliberately:
a toast is pure ephemera with no persistence, and a lib module or the Rust IPC
wrapper must be able to raise one without pulling Pinia into its import graph.

- `toastError(code)` — a **catalogued** error (below). Shows the entry's
  `readableName`, the first `stepsToFix` line as a hint, and the raw code in
  small monospace so the user can search it on the website. An unknown code
  still surfaces, as the bare code: a missing catalogue entry is a docs bug and
  must never swallow the failure it was describing.
- `toastInfo(message)` — plain informational text; no catalogue entry needed.
- Dismissal is automatic (**9 s** for errors, **4 s** for info — long enough to
  read two lines) or by the ✕; `resetToasts()` is the test hook.

`AppToasts.vue` renders the queue bottom-centre on the **`z-tooltip`** layer, the
top of the named z-scale, so a toast is never clipped by a modal or drawer
([ui.md](ui.md#modals)). It is mounted **outside the vault gate** in `App.vue`:
the failures that matter most (a vault that won't unlock, a relay that won't
connect) happen before there is an app to render into. The container is
`role="status"` / `aria-live="polite"` and pointer-events-none except on the
toasts themselves.

## The error catalogue (as built)

Every user-facing error is raised **by code, never by free text**.
`web/src/lib/errors/catalog.json` maps a stable `SCREAMING_SNAKE` code to
`{readableName, description, cause, stepsToFix[]}`, and `lib/errors/index.ts`
gives typed access to it. Why it exists in this shape:

- **One reviewable place for wording.** Error text is UX and often
  security-relevant (it explains a refusal the user did not ask for); scattering
  it across components makes it unreviewable.
- **A code is a stable URL slug.** The website publishes the full entry at a
  per-code URL, so someone who hits a message can look up the cause and the
  steps rather than searching a sentence that may be reworded later.
- **The build enforces it.** `web/test/lib/errors.test.ts` scans `web/src` for
  `toastError('X')` and fails if `X` is missing from the catalogue, and fails
  again if an entry is too thin to help anyone (a `readableName` that is just the
  code, a one-word `cause`, no `stepsToFix`).

Adding a user-visible failure means adding its entry **in the same change** —
this is a rule in `CLAUDE.md`, not a convention.

Catalogued today: **`VOICE_E2EE_UNSUPPORTED`** — the fail-closed voice refusal
(a webview without WebRTC Encoded Transform cannot hold a call, because the
alternative is plaintext Opus reaching the SFU while the UI looks normal). See
[voice.md](voice.md).

## Relay-side push plumbing (built, unreachable)

The relay can send a **content-free wake**, and this is the whole payload:

```json
{ "type": "mail" }
```

No conversation id, no sender, no counts, no content — a strict reduction from
the legacy push, which carried `{conversationId, channelId, seq}` routing hints
so the service worker could deep-link. Under sealed sender the relay does not
know who sent the queued envelope, and the recipient's device can work the rest
out from its own mailbox, so the wake carries nothing at all.

- `Push.notifyMailbox(userId)` (`server/src/push.ts`) fans the wake out to the
  user's stored subscriptions and prunes any the push service reports gone
  (404/410).
- It fires **only when no recipient device is live** (`relayLive.isDeviceOnline`
  in `POST /api/relay/mailbox/send`); connected devices already got the
  `{type:'mail'}` WebSocket nudge, which is the primary path.
- Endpoints: `GET /api/relay/push/key` (VAPID public key, or `null` when push
  isn't configured) plus device-token-authed `POST /api/relay/push/subscribe`
  and `POST /api/relay/push/unsubscribe`.
- VAPID keys come from `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` if set, else are
  generated once and persisted to `DATA_DIR/vapid.json` so existing
  subscriptions survive a restart. Exactly one half configured = disabled
  (a half-configured keypair is a mistake, not a mode).

**Nothing calls `subscribe`.** The browser client that used to is deleted, and
the native shell has no push client: Tauri-webview web-push support is
uncertain, and the live WebSocket nudge already covers the app-open case, which
is the only case the desktop app has. So `notifyMailbox` fans out to an empty
subscription list. `Push.notifyNewMessage` / `notifyReaction` /
`notifyCall` are likewise orphaned — they were the legacy chat server's helpers
and now have no caller.

Which client should hold the device token and register is entangled with the
client model (a future web satellite would register directly; mobile needs
APNs/FCM, not web push), so registration lands with the **mobile shell** —
[roadmap.md](roadmap.md#push-registration-d7).

## Not built

Everything here is unbuilt; none of it should be read as current behaviour.
Tracked in [roadmap.md](roadmap.md#push-registration-d7).

- **Client push registration** (above), and with it any notification while the
  app is closed.
- **Desktop OS notifications** while the app is running but unfocused — even
  this local, no-relay case does not exist yet; only the window title changes.
- **Rich notifications and the preview key.** The design, kept here because the
  reasoning is security-critical and must not be re-derived casually: a
  content-free push wakes a Notification Service Extension (iOS) / background
  handler (Android), which fetches the queued ciphertext and decrypts
  **on-device**, so the relay never sees content even under sealed sender.
  Because that extension runs with **no biometric prompt**, decryption must not
  use MK or content keys — the sender additionally encrypts a small
  `{name, snippet}` blob to a **dedicated preview key**, so a compromised
  preview key exposes *future previews only*, never history or full content, and
  any failure falls back to a generic notification. The notification-privacy
  toggle is then a real security control, not cosmetic: it selects the preview
  key's keychain protection class — *Rich always* (AfterFirstUnlock), *Rich only
  when unlocked* (WhenUnlocked, key unavailable while locked), or *Generic* (no
  extension decryption at all) — with a per-conversation override. A fresh boot
  is always generic until the first unlock.
- **Per-conversation mute / notification overrides.**
- **Push credentials for mobile.** APNs/FCM sends need the app vendor's keys, so
  the first-party relay would hold them in a gitignored `.env`, never embedded
  in source or binaries. **Per-operator push keys are impossible**: APNs/FCM
  credentials are bound to the *app* (bundle id / Firebase project), not the
  server, so only the publisher's developer account can mint them — the same
  constraint that made Matrix build Sygnal. A vendor-run gateway for third-party
  relays is the post-v8 answer. Partial exception: **Android UnifiedPush** lets
  an operator self-host a distributor once the app supports it; **iOS has no
  equivalent**.
