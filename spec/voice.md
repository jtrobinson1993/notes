# v6 — Voice

> **Status: planned / design — not yet implemented.** This is the agreed design
> coming out of the v6 requirements pass. It supersedes the open-ended
> [roadmap.md](roadmap.md#v6--voice) entry ("do deep research first"); the
> research is captured here. No code exists yet.

End-to-end-encrypted **real-time voice** over WebRTC, in two surfaces:

- **Voice channels** — persistent, joinable rooms (the voice-type channels
  created in [v4](chat.md)). Members hop in and out; the room is always there.
- **Direct voice calls** — 1:1 (and small-group) calls with a **ringtone** and an
  **answer / ignore** prompt on the callee's side.

No video (that's [v7](roadmap.md#v7--video-streaming-in-voice-channels)). Crypto
reuses the sealing + epoch-rekey machinery from
[accounts-and-crypto.md](accounts-and-crypto.md) and [chat.md](chat.md); the call
signalling rides the existing chat WebSocket; incoming-call wake-ups reuse
[notifications.md](notifications.md).

## Decisions (confirmed)

These were settled in the v6 requirements pass and drive everything below:

1. **IP privacy is mandatory.** No participant may ever learn another
   participant's IP address. → **all** media flows through a server-side
   forwarding unit (an SFU), **including 1:1 calls** — there is **no
   peer-to-peer / mesh** path, because direct connections leak peer IPs.
2. **Always end-to-end encrypted.** The forwarding server only ever relays
   **sealed media frames it cannot decode**. No "unencrypted for quality" mode —
   encryption costs no meaningful latency and no quality (see
   [§ Encryption cost](#why-this-doesnt-hurt-latency-or-quality)).
3. **Scale is small.** Up to **~10 participants per room**, and (for this
   deployment) **< 10 concurrent calls/rooms** server-wide. No simulcast/SVC,
   no cascading SFUs — a single forwarding instance is plenty.
4. **Self-hosted, single deployable unit.** The SFU must be an **npm dependency
   embedded in the existing Node/Fastify server** — *not* a second standalone
   service (LiveKit/Janus/ion are therefore out). One `docker run`, as today.
5. **Full feature parity** for v6 (see [§ Client features](#client-features)).
6. **Incoming 1:1 calls ring all linked devices; first to answer wins.**
7. **Voice-room presence is visible to all members of the channel** (Discord
   style) so people can join an ongoing conversation.
8. **No recording**, ever — server-side recording is impossible by construction
   (the server can't hear the audio) and no client-side recording feature ships.
9. **Silence suppression (Opus DTX) is required and on.** Clients stop
   transmitting while silent. Accepted tradeoff: this lets the server infer
   speech-activity timing from packet patterns (it still can't hear audio) —
   hiding that timing is the job of bitrate padding, deferred to a future
   follow-up (see [§ Security & privacy](#security--privacy)).

## Architecture

```
 Browser A ──┐                          ┌── Browser B
  mic→Opus    │   sealed Opus frames     │   Opus→speaker
  +E2EE seal  ├──► mediasoup SFU ────────┤   E2EE unseal
  (DTLS-SRTP) │   (forwards opaquely)    │   (DTLS-SRTP)
 Browser C ──┘     in the Node process   └── ...
                          ▲
        signalling + key epochs over the existing chat WebSocket
```

### The forwarding server: mediasoup (embedded)

We use **[mediasoup](https://mediasoup.org) v3** (`npm install mediasoup@3`) — a
**Selective Forwarding Unit** (SFU): a server that receives each participant's
audio **once** and forwards copies to the others. It is the only mature,
production SFU that is **a library you embed in a Node process** rather than a
separate service, which is exactly decision #4.

- **Install is clean.** mediasoup ≥ 3.12 ships **prebuilt worker binaries**, so
  `npm install` is instant and needs no C/C++ toolchain on the target; it only
  falls back to a local build if no prebuilt binary matches. We build inside the
  existing **multi-arch Docker image** (amd64/arm64, both have prebuilt
  binaries), so the end user still just `docker run`s. Node ≥ 22 required —
  already our baseline.
- **One process, with worker subprocesses.** mediasoup runs its media handling in
  **C++ worker subprocesses** (managed by, and children of, our Node process).
  This is a minor deviation from the spec's "single process" line — note it in
  [README.md](README.md) — but it is **still a single deployable unit / one
  container**, not a second service to run, monitor, or install. For our scale
  **one worker** suffices (audio-only, < 10 rooms).
- **It is also the relay.** Because the SFU is publicly reachable, clients connect
  *to it* (client→server direction), so it doubles as the NAT-traversal endpoint.
  **No separate TURN server is needed** — keeping us to the single npm dependency.

### Why not mesh / why not a standalone SFU

- **Mesh (peer-to-peer)** would be simplest and give automatic E2EE, but every
  participant learns every other's IP — fatal for decision #1. Forcing mesh
  through a relay to hide IPs just reinvents a worse SFU.
- **Standalone SFUs (LiveKit, Janus, ion)** are excellent but are separate
  services to deploy and operate — they violate decision #4.

## End-to-end encryption

Two independent encryption layers:

1. **Transport encryption (DTLS-SRTP)** — always-on in WebRTC, between each client
   and the SFU. Protects the hop, but the SFU terminates it, so on its own the
   server *could* hear the audio. This is **not** sufficient for us.
2. **End-to-end frame encryption** — we encrypt each encoded audio frame with a
   key the **server never has**, using the **WebRTC Encoded Transform API**
   (`RTCRtpScriptTransform`) — a hook that runs our code in a Worker *after the
   audio encoder but before packetization*. The SFU sees only opaque ciphertext
   frames it forwards blindly. This is the same technique Jitsi/Zoom/Discord use
   for E2EE, and mediasoup explicitly supports it (it never needs to parse the
   payload, only the RTP headers, which stay in the clear for routing).

Frame payloads are sealed with **AES-GCM** under a per-call **media key** (see
[§ Keys](#keys--membership)). The RTP header and a minimal unencrypted prefix
remain readable so the SFU can route/reorder; everything content-bearing is
sealed.

### Browser support

`RTCRtpScriptTransform` (the standards-track API) is implemented natively in
**Safari** and **Firefox** (and therefore **Zen**, which is Firefox-based).
**Chrome / Edge** (Chromium) need a **small, well-known shim** to match the
standard shape (Chromium historically shipped the older `createEncodedStreams`
variant). We bundle the shim ([webrtcHacks adapter shim / `adapter.js`
PR #1145](https://blog.mozilla.org/webrtc/end-to-end-encrypt-webrtc-in-all-browsers/))
so a **single code path** works across all five targets: Chrome, Edge, Safari,
Firefox, Zen.

> **Research follow-up:** pin minimum versions per engine during implementation
> and add them to [README.md](README.md). The shim has two documented
> Chrome-only workarounds to validate against current Chromium.

### Why this doesn't hurt latency or quality

- Encrypting a ~20 ms Opus frame (tens–hundreds of bytes) with AES-GCM is
  **microseconds** — negligible next to the codec itself, on top of the
  always-present SRTP layer. Encryption is **lossless**: same bits, sealed.
- The real latency contributors are the **jitter buffer** (~20–100 ms) and the
  one SFU hop — neither related to E2EE.
- The *cost* of E2EE is **lost server-side audio features** (server mixing,
  transcoding, server-side noise suppression). We don't want those anyway, and
  all cleanup runs client-side regardless (next point).
- **Noise suppression, echo cancellation, auto-gain** are done by the browser on
  the **raw mic stream, before our encryption** — free and E2EE-compatible.
  Optional heavier ML noise removal (RNNoise-class) can run client-side as
  WASM/AudioWorklet at modest CPU cost. None of it involves the server.

## Keys & membership

The per-call **media key** is distributed with the **exact machinery chat/v5
already use** — seal the key to each member's public key; members unwrap with
their master key. This is the "same key-distribution problem as chat membership"
the roadmap predicted.

- **Per room/call media key**, rotated on an **epoch** like chat conversation
  keys. The voice key may be derived from / pinned to the conversation's current
  chat epoch, or be its own parallel epoch — decide in implementation; the
  mechanism is identical either way.
- **Join → rekey:** when someone joins, bump the epoch so the **newcomer cannot
  decrypt frames captured before they joined**.
- **Leave/kick → rekey:** when someone leaves, bump the epoch so the **departed
  member cannot decrypt any further audio**. This is the security-critical case
  (forward secrecy on removal), mirroring chat's epoch re-key on membership
  change.
- **Boundary (document it):** voice is **ephemeral** — frames are not stored, so
  "prior audio already heard" is simply gone; there is no at-rest plaintext to
  protect, unlike notes. The rekey exists to cut off *future* audio, not to
  protect past frames a member already decrypted in real time.

## Signalling

A new message namespace on the **existing chat WebSocket** (`@fastify/websocket`)
— no new transport. Roughly:

- `voice.join { roomId }` / `voice.leave { roomId }` — room is a channel id (voice
  channel) or a DM/call id (direct call).
- mediasoup handshake: `voice.transport.create`, `voice.transport.connect`
  (DTLS), `voice.produce` (start sending mic), `voice.consume` (start receiving a
  peer) — thin wrappers over mediasoup's router/transport/producer/consumer
  objects.
- `voice.key.epoch { roomId, epoch, sealedKeys[] }` — the rekey fan-out, sealed
  per member (reusing the sharing primitive).
- `voice.presence { roomId, members[] }` — who is currently in the room (drives
  the channel presence UI; see decision #7).

The **room/membership model reuses chat**: a voice channel's allowed set is its
channel membership; a direct call's allowed set is the DM's two (or small-group)
members. Access control therefore inherits chat's existing checks — no new
authorization surface for *who may join*.

## Networking / self-host

- mediasoup needs a **public IP (`announcedIp`)** and a **UDP (and TCP fallback)
  port range (`rtcMinPort`–`rtcMaxPort`)** reachable from clients. On a homelab
  this means **port-forwarding that range** to the host and announcing the WAN
  IP. Document the required ports + an env var for `announcedIp` alongside the
  Docker compose.
- **Bandwidth (the real ceiling on home hardware):** Opus voice ≈ **40 kbps**
  per stream. A full 10-person room ⇒ server **ingest** 10 × 40 ≈ 0.4 Mbps,
  **egress** 10 × 9 × 40 ≈ **3.6 Mbps up**. At < 10 concurrent rooms, worst-case
  is low tens of Mbps **upload** — watch home upload bandwidth; CPU is trivial
  (the SFU only copies packets and *can't* transcode encrypted audio anyway).
- **Opus DTX (Discontinuous Transmission)** — stop sending while silent — is a
  **requirement** (decision #9), cutting real-world bandwidth far below the
  all-talking worst case. Privacy tradeoff in [§ Security & privacy](#security--privacy).

## Direct 1:1 (and small-group) calls

- **Ring all linked devices; first answer wins** (decision #6). Reuses
  [device linking](accounts-and-crypto.md) + the **content-free Web Push**
  pipeline ([notifications.md](notifications.md)) to wake **backgrounded/closed**
  devices (especially mobile PWA). The push is content-free — it signals "call
  from a conversation" and the client fetches details after waking.
- **Answer / ignore** prompt on the callee; answering one device **cancels the
  ring on the others** (a `voice.call.answered` fan-out).
- Handle **timeout** (caller hangs up / "missed call"), **busy/decline**, and
  **caller cancel before pickup**.

## Voice channels

- **Persistent rooms** keyed to a v4 voice-type channel; joining = `voice.join`
  on that channel id.
- **Presence visible to all channel members** (decision #7): the channel list
  shows who's currently in voice, so others can drop in.

## Client features

Full parity, **all client-side** (compatible with E2EE — the server is not
involved in any of these):

- **Mute** (stop your producer) and **deafen** (stop all consumers + mute).
- **Push-to-talk** — hold-to-transmit; toggle in settings.
- **Per-person volume** sliders (local gain per remote consumer).
- **Who's-speaking highlight** — each client already decrypts every peer's audio
  to play it, so it measures **audio energy locally** and highlights the active
  speaker with **zero server metadata**.
- **Connection-quality indicator** — derived from client-side `getStats()`
  (packet loss, jitter, round-trip time).

## Security & privacy

- **IP privacy:** satisfied by construction — all media goes via the SFU; no peer
  ever sees another's address.
- **Server cannot hear audio:** E2EE frame layer; the server only forwards
  ciphertext.
- **Metadata the server *does* learn (be honest):** who is in which call, join/
  leave timing, and packet timing/sizes. With **DTX on (decision #9)** the
  silence gaps make **speech-activity timing** readily observable to the server
  via traffic analysis — it still **never** learns audio content or who is
  speaking *from content*.
- **Bitrate padding — future follow-up (not v6).** Sending constant-rate,
  constant-size traffic whether talking or silent would hide speech-activity
  timing from the server. It is deliberately deferred. Note the tension: padding
  is the **opposite** of DTX — to hide silence you must transmit through it, so
  padding largely **gives back the bandwidth DTX saves**. They're a privacy ↔
  bandwidth dial, not additive savings; v6 picks bandwidth (DTX on, no padding)
  and revisits padding later if speech-timing privacy is wanted.
- **No recording** (decision #8).
- **Authorization** to join a room is exactly chat membership — no weaker path.

## Testing plan

Per [testing.md](testing.md) and `CLAUDE.md`:

- **Unit (server):** signalling message handling, room membership ↔ chat-access
  enforcement (a non-member cannot `voice.join`), key-epoch fan-out, rekey on
  join/leave, presence correctness.
- **Unit (crypto/web):** media-key seal/unwrap reusing the sharing primitive;
  the frame-encrypt/decrypt transform (encrypt → decrypt round-trips, wrong-epoch
  key fails); the Chrome shim selection logic.
- **Unit (web/stores):** call state machine (ringing → answered/ignored/timeout/
  busy/cancelled), multi-device first-answer-wins cancellation, mute/deafen/PTT
  state.
- **E2E (Playwright):** join/leave a voice channel and presence updates using
  **fake media devices** (`--use-fake-device-for-media-stream`); ring/answer/
  ignore flow. Actual audio fidelity is out of automated scope.

## Open questions / research follow-ups

- Pin **minimum browser versions** per engine for `RTCRtpScriptTransform` + shim;
  record in [README.md](README.md).
- Decide whether the **voice media key is its own epoch** or **pinned to the chat
  conversation epoch**.
- Confirm **mobile PWA background wake** reliability for incoming calls on iOS
  Safari (Web Push limitations) — may constrain the "ring all devices" promise on
  iOS.
- mediasoup **worker count / `announcedIp` + port-range** defaults and Docker
  documentation.
- Codec params (Opus target bitrate, FEC) defaults. DTX is fixed on (decision #9).
- **Bitrate padding** to hide speech-activity timing — design + opt-in, **future
  follow-up** (see [§ Security & privacy](#security--privacy)).
