// v8 voice call engine — the framework-agnostic lifecycle brain
// (spec/voice.md § v8). Media flows through the relay's **mediasoup SFU** (as v6
// already does, and as the spec requires so neither caller learns the other's
// IP), NOT peer-to-peer. So this engine handles *call control* only — ring,
// accept, hangup, and peer presence — while the actual audio is produced/
// consumed against the SFU by the injected `CallMedia` (a mediasoup-client
// wrapper in the webview; browser libwebrtc + insertable-streams frame E2EE).
// The engine owns no WebRTC/mediasoup types, so it is fully unit testable with a
// fake media + spy effects.
//
// Presence drives the flow: the *caller* mints a ring (relayCallOffer) and joins
// the call's signaling room; when the callee accepts and appears (`peer-join`)
// the caller joins the SFU room too. The *callee* answers an inbound ring and
// joins both. Each side produces its mic to the SFU and consumes the other's
// track; `onMediaConnected` marks the call live. The signaling socket only
// carries control — no SDP/ICE ever crosses it (the SFU handles transport).

export type CallState = 'idle' | 'dialing' | 'ringing' | 'connecting' | 'connected' | 'ended';

export type CallRole = 'caller' | 'callee';

/** The media layer the engine drives — a mediasoup-client SFU wrapper in the
 *  app. `join` connects to the SFU room (== call id): create transports, produce
 *  the mic, consume peers. Opaque/async so the engine stays media-agnostic. */
export interface CallMedia {
  /** Connect to the SFU room and start producing/consuming. */
  join(callId: string): Promise<void>;
  /** Release mic, transports, and consumers. */
  close(): void;
}

/** Side effects the engine issues, injected so it never imports the IPC layer.
 *  `join`/`leave` operate the call-control **signaling room** (not the SFU). */
export interface CallEffects {
  /** Mint a ring for a contact; resolves to the call id to join. */
  placeRing(contactId: string): Promise<string>;
  /** Join / leave the signaling room (peer-join/peer-leave presence). */
  join(callId: string): Promise<void>;
  leave(callId: string): Promise<void>;
  /** Notify the UI of a state change. */
  onState?(state: CallState): void;
}

export class VoiceCall {
  state: CallState = 'idle';
  role: CallRole | null = null;
  callId: string | null = null;
  /** For an incoming ring: the verified caller's identity pubkey. */
  peerId: string | null = null;
  /** Whether we've joined the SFU (so hangup knows to close media). */
  private mediaJoined = false;

  constructor(private media: CallMedia, private fx: CallEffects) {}

  private set(state: CallState): void {
    this.state = state;
    this.fx.onState?.(state);
  }

  private get busy(): boolean {
    return this.state !== 'idle' && this.state !== 'ended';
  }

  /** Outgoing: ring a contact and join the signaling room. We join the SFU only
   *  once the callee accepts (`peer-join`), so the mic isn't hot while it rings. */
  async placeCall(contactId: string): Promise<void> {
    if (this.busy) throw new Error('already in a call');
    this.role = 'caller';
    this.peerId = contactId;
    this.set('dialing');
    this.callId = await this.fx.placeRing(contactId);
    await this.fx.join(this.callId);
  }

  /** Inbound ring surfaced by the drain. Ignored (auto-busy) if already in a
   *  call — the caller simply times out. */
  onIncomingRing(callId: string, callerId: string): void {
    if (this.busy) return;
    this.role = 'callee';
    this.callId = callId;
    this.peerId = callerId;
    this.set('ringing');
  }

  /** Callee accepts: join the signaling room and the SFU (produce mic). */
  async accept(): Promise<void> {
    if (this.state !== 'ringing' || !this.callId) return;
    this.set('connecting');
    await this.fx.join(this.callId);
    await this.joinMedia(this.callId);
  }

  /** Callee declines a ring before answering (never joined → nothing to leave). */
  decline(): void {
    if (this.state !== 'ringing') return;
    this.reset('ended');
  }

  /** Hang up an active/ringing/dialing call: release media + leave the room. */
  async hangup(): Promise<void> {
    if (this.state === 'idle' || this.state === 'ended') return;
    const id = this.callId;
    this.reset('ended');
    if (id) await this.fx.leave(id);
  }

  /** The media layer reports SFU audio is flowing. */
  onMediaConnected(): void {
    if (this.state === 'connecting') this.set('connected');
  }

  /** Handle one inbound call-control frame (from nativeVoice `voice:frame`). */
  async onFrame(frame: { type: string; callId?: string }): Promise<void> {
    if (!this.callId || frame.callId !== this.callId) return; // not our call
    switch (frame.type) {
      case 'peer-join':
        // Caller: the callee accepted and joined → join the SFU ourselves.
        if (this.role === 'caller' && this.state === 'dialing') {
          this.set('connecting');
          await this.joinMedia(this.callId);
        }
        return;
      case 'peer-leave':
        this.reset('ended'); // remote hung up / dropped
        return;
      default:
        return;
    }
  }

  private async joinMedia(callId: string): Promise<void> {
    await this.media.join(callId);
    this.mediaJoined = true;
  }

  private reset(state: CallState): void {
    if (this.mediaJoined) this.media.close();
    this.mediaJoined = false;
    this.set(state);
    this.role = null;
    this.callId = null;
    this.peerId = null;
  }
}
