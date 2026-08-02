# Voice

> **Status: built end-to-end, never validated on real hardware.** A 1:1 call in
> the native app runs the whole path — ring → signaling socket → mediasoup SFU →
> mic with per-frame E2EE → call panel — and is covered by unit tests plus a
> Playwright spec against a real mediasoup worker. It has **never been exercised
> on two real devices with real microphones**. That validation is the outstanding
> item and gates all further voice work
> ([roadmap.md](roadmap.md#real-device-voice-validation)).

Where the code lives:

| Half | Files |
|---|---|
| Relay | `server/src/voiceSignal.ts` (signaling WS), `server/src/voiceSfu.ts` (mediasoup SFU) |
| Rust core | `src-tauri/src/voice_live.rs` (holds the signaling socket), `relay_call_offer` + the `voice_*`/`sfu_*` IPC commands in `lib.rs`, `KIND_CALL_OFFER` in `message.rs` |
| Web (UI only) | `lib/voiceCall.ts` (engine), `nativeVoiceCall.ts` + `useNativeCall.ts` (wiring), `callHost.ts` (the app's single call), `voiceMedia.ts` + `nativeCallMedia.ts` + `nativeSfu.ts` (media/SFU control), `voiceTransform.ts` + `voiceFrameWorker.ts` + `voiceCrypto.ts` (frame E2EE), `components/NativeCallPanel.vue` + `NativeCallHost.vue` |

## Scope as built

- **1:1 calls only.** The call button in the DM header rings that friend
  (`NativeChat.vue` → `callHost().placeCall`); a global panel
  (`NativeCallHost.vue`) shows the ring/answer/hang-up UI wherever you are in the
  app. Group chats have no call button. The relay caps a call at 8 devices, but
  that is a ceiling on a leaked call id (below), not a group-call feature.
- **Native only.** Voice is part of the Tauri app; there is no browser client at
  all (see [roadmap.md](roadmap.md#d16--a-v8-web-client-deferred)).
- **No voice channels.** v6's persistent, joinable voice rooms were keyed to
  server-side channel membership, which the relay cannot know — it hides the
  social graph — and the server that hosted them is deleted. Nothing joins a
  persistent room today; the only room that exists is a call.
- **No video** — see [roadmap.md](roadmap.md#v12--video-streaming-in-voice-channels).
- **No recording**, ever. Server-side recording is impossible by construction
  (the relay can't decode the audio) and no client-side recording ships.

## Decisions that still hold

1. **IP privacy is mandatory.** No participant may learn another's IP address, so
   **all** media flows through the SFU, **including 1:1 calls**. There is no
   peer-to-peer / mesh path — direct connections leak peer IPs, and routing mesh
   through a relay to hide them just reinvents a worse SFU.
2. **Always end-to-end encrypted.** The SFU only ever forwards sealed frames it
   cannot decode. There is no "unencrypted for quality" mode, and as of the
   fail-closed change there is no unencrypted mode *at all* (next section).
3. **Scale is small** — ≤ 8 devices per call and a handful of concurrent calls.
   No simulcast/SVC, no cascading SFUs; one mediasoup worker is plenty.
4. **The SFU is embedded in the relay**, not a second service: `mediasoup` is an
   npm dependency of the relay process (LiveKit/Janus/ion are separate
   deployables and were rejected for that reason). The worker is a child process
   started **lazily on the first join**, so relays and test runs that never place
   a call never start it.
5. **No silence suppression (Opus DTX).** Every joined mic transmits
   continuously, so the bandwidth figures below are the sustained case — and the
   per-stream rate stays roughly flat, which is why speech-activity timing is not
   exposed as on/off gaps (see [§ Security & privacy](#security--privacy)).

## Fail closed: no call without frame E2EE

**A call that cannot be frame-encrypted is refused, not downgraded.** This is the
one place voice deliberately takes a decision away from the user, and it is worth
stating why:

- The relay/SFU never seeing plaintext audio is the *premise* of the feature, not
  a nice-to-have. A call whose frames aren't sealed is a different product.
- The previous behaviour was the dangerous kind of failure: on a webview without
  WebRTC Encoded Transform the frame key was still exchanged, the transforms were
  simply never attached, plaintext Opus went to the SFU — and the UI was
  **indistinguishable from an ordinary encrypted call**. There was no indicator
  and no way for a user to notice.
- Given a choice between "no call" and "a call that silently isn't private",
  refusing is the answer that can't hurt anyone. A refused call is visible and
  explainable; a silently plaintext call is neither.

Two independent layers used to fail open, either one of which leaked on its own.
Both are now closed:

- **`voiceTransform.ts`** — `encryptSender()` / `decryptReceiver()` used to
  no-op when `RTCRtpScriptTransform` was missing. They now **throw**
  `VOICE_E2EE_UNSUPPORTED`, so audio cannot reach the wire unsealed.
- **`nativeCallMedia.ts`** — used to pass the encrypt/decrypt hooks as
  `undefined` when unsupported. It now **always** passes them, so a media layer
  without encryption is not constructible in the app. (The hooks are optional in
  the injectable `CallMediaDeps` interface purely so `voiceMedia.ts` can be
  unit-tested with fakes; the app path never omits them.)

On top of those, **`callHost.ts` gates the two entry points that would put audio
on the wire** — `placeCall` and `accept` — on `voiceE2eeSupported()`, so the user
gets the `VOICE_E2EE_UNSUPPORTED` toast (from
[the error catalogue](../web/src/lib/errors/catalog.json)) instead of an
exception. Refusing to answer also **declines the ring**, so the caller stops
waiting on an answer that can never come rather than ringing out. **`decline` and
`hangup` are never gated** — ending a call must always work.

Belt and braces in the worker: the encrypt path drops a frame when no media key
is loaded yet, rather than passing it through in the clear
(`voiceFrameWorker.ts`).

Pinned by `web/test/lib/callHost.e2ee.test.ts` (refuse to place, refuse+decline
on answer, hang-up still allowed, normal path unaffected).

### Webview support

The relevant target is no longer a browser matrix — it is the **system webview
the Tauri shell embeds**: WebKitGTK on Linux, WebView2 on Windows, WKWebView on
macOS. We use the standards-track `RTCRtpScriptTransform` directly, with no
`createEncodedStreams` fallback; `voiceE2eeSupported()` is a plain
`typeof RTCRtpScriptTransform !== 'undefined'` check. Where a webview lacks it
the user is told which component to update
(`stepsToFix` in the catalogue entry). Which shipping webview versions actually
provide it is one of the things real-device validation has to establish.

## Architecture

```
 Device A ──┐                              ┌── Device B
  mic→Opus   │     sealed Opus frames       │   Opus→speaker
  +AES-GCM   ├──►  mediasoup SFU  ──────────┤   frame unseal
  (DTLS-SRTP)│   (relay process, opaque)    │   (DTLS-SRTP)
             │                              │
             └──  /api/relay/voice WS  ─────┘   call control (join/leave/peers)
                          ▲
             the ring itself rides the sealed-sender mailbox
```

Three planes, deliberately separate:

- **Ring** — a sealed `call-offer` envelope through the ordinary mailbox.
- **Call control** — a device-token-authed WebSocket, `/api/relay/voice`.
- **Media** — REST control of the SFU plus RTP straight from the webview to the
  SFU.

### Ringing (single relay)

`relay_call_offer` (Rust core) mints a fresh **256-bit call id** (base64url — the
routing capability) and a fresh **256-bit frame key**, then seals
`{callId, mediaKey}` into the friend's mailbox as a `KIND_CALL_OFFER` envelope.
Because the key rides *inside* the already-sealed envelope, **the relay and the
SFU never see it**.

- The caller gets `{callId, mediaKey}` back, arms its send key, and joins the
  signaling room. The mic is **not** hot while it rings — the caller joins the
  SFU only when the callee appears.
- The callee's drain verifies the envelope like any other, so the caller is the
  **cryptographically verified sender** (a ring cannot be spoofed), and surfaces
  it in `DrainReport.calls`. A ring is **ephemeral**: always acked, never
  re-buffered, and the UI drops one older than **60 s** (`RING_TTL_MS`) rather
  than ringing for a call that has long since been abandoned.
- A ring arriving while already in a call is ignored (auto-busy); the caller
  simply times out.
- A malformed offer — empty call id, or a media key that isn't 32 bytes — is
  **discarded, not trusted** (`message.rs`), so a peer can't force a call onto a
  weak or absent key.

**Cross-relay fan-out is not built** (D4c). Deferred deliberately, not
overlooked: ringing every relay a contact is linked on at the same instant is a
recognizable call-setup signature and hands colluding relays a timing linkage, so
it needs independent per-relay sealing (call id inside each ciphertext) plus
sized/jittered delivery. See
[roadmap.md](roadmap.md#multi-relay--cross-relay-contact-continuity-d4c).

### Call control — `GET /api/relay/voice`

A **dedicated** device-token-authed WebSocket (`voiceSignal.ts`), bearer token
only: no cookie and no Origin check, because the client is native and there is no
CSRF surface. Rooms are keyed by call id.

- Client frames: `join` / `leave` / `signal` (+ `ping`).
- Server frames: `hello`, `joined {peers}`, `peer-join`, `peer-leave`,
  `signal {payload}`, `error`.
- The relay forwards a `signal` **only for a call the sender actually joined**,
  so a device can't spray frames into rooms it isn't in.
- Caps, all defense-in-depth around a *leaked* call id: 8 peers per call, 8 calls
  per socket, 64 KB per frame, and a call-id charset/length check
  (`[A-Za-z0-9_-]{8,128}`). A 30 s ping/pong heartbeat reaps dead sockets.

The Rust core (`voice_live.rs`) owns the socket — device-bearer auth refreshed
per connect from the device key alone (so it survives a locked vault), reconnect
with backoff — and pumps it both ways: `voice_join`/`voice_signal`/`voice_leave`
IPC in, inbound frames out as the `voice:frame` Tauri event, which
`nativeVoice.ts` fans to the call UI.

**In practice `signal` carries no SDP/ICE.** Because media goes through the SFU,
transport negotiation happens over the SFU's REST endpoints; the signaling socket
carries presence (`peer-join`/`peer-leave`) and the SFU's producer announcements.
The `signal` relay stays because it is the seam a future non-SFU or cross-relay
path would use, and its payload is opaque to the relay either way.

### Media — the SFU (`/api/relay/voice/rooms/:callId/*`)

`voiceSfu.ts`: a mediasoup SFU whose **rooms are keyed by call id**. Authorization
is a **valid device token plus the call id** — not v6's social-graph room
resolution, which is impossible under a graph-hiding relay (see
[§ Security & privacy](#security--privacy) for what that does and doesn't buy).

- `POST …/join` → `{ routerRtpCapabilities, peers }`. Device token + a
  well-formed call id; joining *is* what makes you a member (409 if the room is
  already full).
- `POST …/transport` (send | recv) / `…/transport/connect` (DTLS).
- `POST …/produce` / `…/consume`.
- `POST …/leave` — closes transports, and closes the router when the room empties.

The four media endpoints additionally require **current membership** of that room
and operate only on transports the calling device owns.

Notable properties:

- **No server-side media keys and no rekey machinery.** Frame E2EE is purely
  client-side insertable streams, so the SFU relays ciphertext RTP and has
  nothing to distribute. (v6's owner-coordinated epoch rekey, which sealed keys
  over the legacy hub, is gone with it.)
- **The roster is identity-free**: peers are ephemeral per-join `participantId`s
  minted at join time, never device ids or user identities.
- On `produce`, the SFU **announces the new producer** to the call's other
  devices over the signaling room (`VoiceSignal.notifyRoom` → a `signal` frame
  with `{kind:'producer', producerId}`), which the client turns into
  `media.onProducer(...)` → `consume`.
- Codec is **Opus only** (48 kHz stereo), matching v6.

The six control calls are proxied **through the Rust core**
(`relay_client.rs` `sfu_*` → device-token-authed POSTs, opaque mediasoup JSON
passthrough) and exposed as `sfu_*` IPC commands; `nativeSfu.ts` implements the
`SfuControl` interface via `invoke`. **The device token never crosses IPC.** Media
and RTP still flow webview↔SFU directly — only the control plane detours through
Rust.

`voiceMedia.ts` (`createCallMedia`) drives the mediasoup-client flow: `device.load`
→ send/recv transports → produce mic → consume peers. Every browser-only
dependency is **injected** (SFU control, Device factory, mic track, frame-E2EE
hooks), which is what makes the orchestration unit-testable;
`nativeCallMedia.ts` supplies the real ones (`getUserMedia` with echo
cancellation / noise suppression / AGC, remote tracks played through a detached
`<audio>`).

### The call engine

`voiceCall.ts` is a framework-agnostic `VoiceCall` state machine —
`idle → dialing | ringing → connecting → connected → ended` — owning **call
control only** (ring, accept, decline, hang up, peer presence). It imports no
WebRTC or IPC types; media and effects are injected, so it is fully unit tested.
`nativeVoiceCall.ts` binds it to the IPC seams, `useNativeCall.ts` exposes it as
Vue refs, and `callHost.ts` is the app's single instance shared by the panel and
the DM call button.

Locking the vault tears the call down (`teardownCallHost`): a live call's frame
key comes from state the master key protects, so no call may outlive an unlocked
vault. It is a no-op when no call has been placed, so locking never spins up
mic/mediasoup machinery just to tear it down.

## Frame encryption

Two independent layers:

1. **DTLS-SRTP** — always on in WebRTC, between each client and the SFU. It
   protects the hop, but the SFU terminates it, so on its own the relay *could*
   hear the audio. Not sufficient.
2. **End-to-end frame encryption** — each encoded Opus frame is sealed with
   **AES-256-GCM** under the call's media key, inside a Worker attached via
   `RTCRtpScriptTransform` (after the encoder, before packetization). The SFU
   sees opaque payloads; it only needs the RTP headers, which stay in the clear
   for routing.

Wire format of a sealed frame payload (`voiceCrypto.ts`):

```
[ epoch: 4 bytes big-endian ][ iv: 12 bytes ][ AES-GCM ciphertext+tag ]
```

The epoch prefix lets a receiver pick the right key across a rekey, and is safe
to prepend because the SFU treats the payload as opaque. Frames that fail to
decrypt — unknown epoch, tampered, or truncated — are **dropped, not played**.

**Keys.** A 1:1 call uses **one** key for its lifetime, installed at a fixed
`epoch 0` by `callHost.ts` from the exchanged ring. The epoch machinery exists
(per-epoch key map, `setSendEpoch`, `dropFrameKey`) and the frame format carries
the epoch, but **nothing rotates a key today**: v6's join/leave rekey belonged to
multi-party rooms with server-coordinated membership, and 1:1 calls with a
per-call random key have no membership change to rekey for. Group calls would
need that machinery revived.

**Voice is ephemeral.** Frames are never stored, so there is no at-rest plaintext
to protect the way notes have. A rekey (if group calls arrive) would exist to cut
off *future* audio, never to protect frames a member already decrypted live.

### Why E2EE costs nothing here

- Sealing a ~20 ms Opus frame (tens–hundreds of bytes) with AES-GCM takes
  microseconds — negligible beside the codec, on top of the always-present SRTP
  layer. Encryption is lossless: same bits, sealed.
- The real latency contributors are the jitter buffer (~20–100 ms) and the one
  SFU hop; neither is related to E2EE.
- What E2EE *does* cost is server-side audio features — mixing, transcoding,
  server-side noise suppression. We don't want them, and the SFU couldn't do them
  on ciphertext anyway.
- Echo cancellation, noise suppression and auto-gain run in the webview on the
  **raw mic stream, before encryption** (`MIC_CONSTRAINTS` in
  `nativeCallMedia.ts`) — free and E2EE-compatible.

## In-call features — mostly not built

The call panel (`NativeCallPanel.vue`) is deliberately minimal: call phase
(`Incoming call` / `Calling…` / `Connecting…` / `In call`), the peer's display
name resolved from the friend list (never a raw pubkey), and **Accept / Decline**
or **Hang up / Cancel**. That is all it does.

Not built — do not read v6's feature list into the current app:

- **Mute, deafen, per-person volume, who's-speaking highlight, connection-quality
  indicator** — none exist.
- **Push-to-talk and RNNoise noise-suppression strength** have **Settings → Voice
  UI and persisted device preferences** (`voicePrefs.ts`, `SettingsPage.vue`) but
  **nothing reads them in the call path**: the mic is always open, and no RNNoise
  worklet is loaded (`@sapphi-red/web-noise-suppressor` is a dependency, unused
  in `web/src`). The settings are inert today.
- **The `connected` state is never reached in the app.** `VoiceCall` has
  `onMediaConnected()` to move `connecting → connected`, but only tests call it —
  no production code does, so the panel stays on "Connecting…" for the life of
  the call even when audio is flowing. Wiring that up belongs with real-device
  validation, since that's when the transition can actually be observed.

These are UI work, not protocol work; see
[roadmap.md](roadmap.md#ui-surfaces-not-built).

## Networking / self-host

- mediasoup needs a **public address** (`VOICE_ANNOUNCED_IP`, default
  `127.0.0.1` — a single-host default that **must** be set for a real
  deployment), a listen address (`VOICE_LISTEN_IP`, default `0.0.0.0`) and a
  **UDP+TCP port range** (`VOICE_RTC_MIN_PORT`–`VOICE_RTC_MAX_PORT`, default
  40000–40100) reachable from clients. On a homelab that means forwarding that
  range and announcing the WAN address.
- **No separate STUN/TURN server.** The SFU is publicly reachable and clients
  connect *to it*, so it doubles as the NAT-traversal endpoint; transports are
  created with UDP preferred and TCP enabled as fallback.
- **Bandwidth is the real ceiling on home hardware.** Opus voice ≈ 40 kbps per
  stream, and with DTX off that is sustained, not peak. A 1:1 call is trivial; a
  full 8-device room is ~0.3 Mbps ingest and ~2.2 Mbps egress. CPU is trivial —
  the SFU copies packets and *cannot* transcode encrypted audio anyway.

## Security & privacy

- **IP privacy** — satisfied by construction: all media goes via the SFU, so no
  participant ever sees another's address.
- **The relay cannot hear audio** — frames are sealed under a key minted by the
  caller and delivered inside a sealed envelope. The relay never handles a media
  key, and there is no code path that produces audio without the transform
  attached (see [§ Fail closed](#fail-closed-no-call-without-frame-e2ee)).
- **Authorization to join a call is possession of the call id**, plus a valid
  device token on that relay. There is no friendship check at the SFU — the relay
  hides the social graph, so it cannot make one. The call id is 192 bits of
  randomness delivered only inside a sealed offer, and a stranger who somehow
  obtained one gains **nothing readable**: frames are sealed to a key that rode
  inside the envelope, so they'd receive ciphertext they can't decrypt and any
  audio they produced would be dropped by the peers as undecryptable. The 8-peer
  cap stops a leaked id from being packed with listeners.
- **Metadata the relay does learn:** which authenticated devices share a call id,
  join/leave timing, and packet timing/sizes. That is the same fact the SFU
  necessarily knows to route media. It learns no identities in cleartext from the
  signaling socket, no audio content, and not who is speaking.
- **Speech-activity timing is largely not exposed**, because DTX is off: every
  joined mic transmits continuously, so the per-stream rate is roughly flat.
  (Some residual leak from variable frame sizes in VBR is possible.) **If DTX is
  ever added for bandwidth, that leak returns** — silence gaps and cross-party
  turn-taking become observable. The mitigations are a privacy↔bandwidth dial,
  not free: constant-rate padding is strong but gives back everything DTX saved,
  and sub-rate "chaffing" is partial only (real speech is always sent, so the
  envelope still rises during it). None is needed while DTX stays off; see
  [roadmap.md](roadmap.md#smaller-deferred-items).
- **No recording**, by construction and by omission.

## Testing

- **Unit (crypto/web):** the frame crypto round-trip including wrong-epoch and
  tamper rejection (`web/test/crypto/voiceCrypto.test.ts`); the call engine
  against a fake media layer (`voiceCall.test.ts`); the native wiring
  (`nativeVoiceCall.test.ts`, `useNativeCall.test.ts`, `nativeVoice.test.ts`);
  the SFU orchestration with fakes (`voiceMedia.test.ts`, `nativeSfu.test.ts`);
  the fail-closed gate (`callHost.e2ee.test.ts`); device prefs
  (`voicePrefs.test.ts`).
- **Unit (server):** the signaling hub — join/leave, room isolation, the caps,
  producer notification (`voiceSignal.test.ts`, `voiceSignal.notify.test.ts`) —
  and the SFU routes' auth/membership matrix (`routes.relay.voicesfu.test.ts`).
- **Unit (Rust):** call-offer sealing/verification, including rejection of an
  empty call id or a short media key (`message.rs`).
- **E2E (Playwright):** `e2e/voice.spec.ts` drives the **real relay and a real
  mediasoup worker**. Two independent devices authenticate through **production
  endpoints only** — `POST /api/relay/register`, then the real challenge →
  signed-nonce → token flow (`e2e/helpers/deviceToken.ts`); there is no test-auth
  seam — and join the same call room, asserting Opus capabilities, an
  identity-free roster, and a 401 without a token.
- **Deliberately not automated:** the in-browser media round-trip (getUserMedia →
  produce → consume with frame E2EE), which needs a bundled same-origin harness
  page and is timing-sensitive, and the frame Worker itself (no
  `RTCRtpScriptTransform` in jsdom/Node). Both are gated behind real-device
  validation — see [roadmap.md](roadmap.md#before-launch).
