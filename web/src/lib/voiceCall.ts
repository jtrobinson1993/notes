// v8 voice call engine — the framework-agnostic lifecycle + signaling brain
// (spec/voice.md § v8). Sits between the signaling seam (nativeVoice: join /
// leave / signal frames + the voice:frame stream) and a media layer (a thin
// RTCPeerConnection wrapper in the webview — the decided home for media, since
// browser libwebrtc is the hardened, maintained stack; frame E2EE rides
// insertable streams). This module owns *no* WebRTC types so it is fully unit
// testable with a fake media + spy effects; the real app injects an
// RTCPeerConnection-backed CallMedia and the nativeVoice IPCs.
//
// Roles: the *caller* mints a ring (relayCallOffer), joins, and — once the
// callee appears (`peer-join`) — sends the SDP offer. The *callee* answers an
// inbound ring, joins, and replies to the offer. Either side streams ICE. SDP
// and ICE travel as opaque, E2E-sealed `signal` payloads tagged by kind.

export type CallState = 'idle' | 'dialing' | 'ringing' | 'connecting' | 'connected' | 'ended';

export type CallRole = 'caller' | 'callee';

/** A signal payload as it rides a `signal` frame — tagged so the peer knows how
 *  to apply it. `data` is opaque SDP/ICE (E2E-sealed end to end). */
export interface CallSignal {
  kind: 'offer' | 'answer' | 'ice';
  data: unknown;
}

/** The media layer the engine drives (an RTCPeerConnection wrapper in the app).
 *  Every method is async/opaque so the engine stays WebRTC-agnostic. */
export interface CallMedia {
  /** Caller: produce the SDP offer to send. */
  createOffer(): Promise<unknown>;
  /** Callee: apply the remote offer, produce the SDP answer to send. */
  handleOffer(offer: unknown): Promise<unknown>;
  /** Caller: apply the remote answer. */
  handleAnswer(answer: unknown): Promise<void>;
  /** Either: add a remote ICE candidate. */
  addIce(candidate: unknown): Promise<void>;
  /** Release mic + peer connection. */
  close(): void;
}

/** Side effects the engine issues, injected so it never imports the IPC layer. */
export interface CallEffects {
  /** Mint a ring for a contact; resolves to the call id to join. */
  placeRing(contactId: string): Promise<string>;
  join(callId: string): Promise<void>;
  leave(callId: string): Promise<void>;
  sendSignal(callId: string, payload: CallSignal): Promise<void>;
  /** Notify the UI of a state change. */
  onState?(state: CallState): void;
}

export class VoiceCall {
  state: CallState = 'idle';
  role: CallRole | null = null;
  callId: string | null = null;
  /** For an incoming ring: the verified caller's identity pubkey. */
  peerId: string | null = null;

  constructor(private media: CallMedia, private fx: CallEffects) {}

  private set(state: CallState): void {
    this.state = state;
    this.fx.onState?.(state);
  }

  private get busy(): boolean {
    return this.state !== 'idle' && this.state !== 'ended';
  }

  /** Outgoing: ring a contact and join the call room. The offer is sent once the
   *  callee appears (`peer-join`), so we don't offer into an empty room. */
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

  /** Callee accepts: join the room and wait for the caller's offer. */
  async accept(): Promise<void> {
    if (this.state !== 'ringing' || !this.callId) return;
    this.set('connecting');
    await this.fx.join(this.callId);
  }

  /** Callee declines a ring before answering (never joined → nothing to leave). */
  decline(): void {
    if (this.state !== 'ringing') return;
    this.reset('ended');
  }

  /** Hang up an active/ringing/dialing call: leave the room and release media. */
  async hangup(): Promise<void> {
    if (this.state === 'idle' || this.state === 'ended') return;
    const id = this.callId;
    this.reset('ended');
    if (id) await this.fx.leave(id);
  }

  /** A local ICE candidate from the media layer — forward it to the peer. */
  async localIce(candidate: unknown): Promise<void> {
    if (!this.callId || !this.busy) return;
    await this.fx.sendSignal(this.callId, { kind: 'ice', data: candidate });
  }

  /** The media layer reports the peer connection is live. */
  onMediaConnected(): void {
    if (this.state === 'connecting') this.set('connected');
  }

  /** Handle one inbound signaling frame (from nativeVoice `voice:frame`). */
  async onFrame(frame: { type: string; callId?: string; payload?: unknown }): Promise<void> {
    // Only frames for our current call matter.
    if (!this.callId || frame.callId !== this.callId) return;
    switch (frame.type) {
      case 'peer-join':
        // Caller: the callee joined → send the offer now.
        if (this.role === 'caller' && this.state === 'dialing') {
          this.set('connecting');
          const offer = await this.media.createOffer();
          await this.fx.sendSignal(this.callId, { kind: 'offer', data: offer });
        }
        return;
      case 'signal':
        await this.applySignal(frame.payload as CallSignal | undefined);
        return;
      case 'peer-leave':
        // Remote hung up / dropped.
        this.reset('ended');
        return;
      default:
        return;
    }
  }

  private async applySignal(sig: CallSignal | undefined): Promise<void> {
    if (!sig || !this.callId) return;
    switch (sig.kind) {
      case 'offer':
        // Callee applies the offer and replies with an answer.
        if (this.role === 'callee') {
          const answer = await this.media.handleOffer(sig.data);
          await this.fx.sendSignal(this.callId, { kind: 'answer', data: answer });
        }
        return;
      case 'answer':
        if (this.role === 'caller') await this.media.handleAnswer(sig.data);
        return;
      case 'ice':
        await this.media.addIce(sig.data);
        return;
    }
  }

  private reset(state: CallState): void {
    this.media.close();
    this.set(state);
    this.role = null;
    this.callId = null;
    this.peerId = null;
  }
}
