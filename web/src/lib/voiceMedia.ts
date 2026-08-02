// v8 voice media layer — the mediasoup-client SFU orchestration behind the
// `CallMedia` interface the call engine drives (spec/voice.md § v8). Adapts the
// proven v6 flow (device.load → send/recv transports → produce mic → consume
// peers) to the v8 capability SFU. Everything browser-only is *injected* — the
// SFU control transport, the mediasoup-client Device factory, the mic track,
// and the frame-E2EE hooks — so this orchestration is unit-testable with fakes;
// the app wires the real deps (Rust-IPC-proxied control, mediasoup-client
// Device, getUserMedia, insertable-streams encrypt/decrypt) and e2e drives it
// with real browser media.

import type { CallMedia } from './voiceCall';

/** Peer roster entry from an SFU join. */
export interface SfuPeer {
  participantId: string;
  producerId: string | null;
}
export interface SfuJoinResult {
  routerRtpCapabilities: unknown;
  peers: SfuPeer[];
}

/** The SFU control plane (device-token authed). In the app these calls are
 *  proxied through the Rust core (which holds the device token); in e2e they hit
 *  the relay REST directly. Payloads are opaque mediasoup blobs. */
export interface SfuControl {
  join(callId: string): Promise<SfuJoinResult>;
  createTransport(callId: string, direction: 'send' | 'recv'): Promise<unknown>;
  connectTransport(callId: string, transportId: string, dtlsParameters: unknown): Promise<void>;
  produce(callId: string, transportId: string, rtpParameters: unknown): Promise<{ producerId: string }>;
  consume(
    callId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: unknown,
  ): Promise<{ id: string; rtpParameters: unknown }>;
  leave(callId: string): Promise<void>;
}

// Minimal structural shapes of the mediasoup-client bits we touch, so the engine
// is testable with a fake device (the real Device is browser-only).
type ConnectArgs = { dtlsParameters: unknown };
type ProduceArgs = { rtpParameters: unknown };
export interface MsTransport {
  id: string;
  on(event: 'connect', h: (a: ConnectArgs, cb: () => void, eb: (e: unknown) => void) => void): void;
  on(event: 'produce', h: (a: ProduceArgs, cb: (r: { id: string }) => void, eb: (e: unknown) => void) => void): void;
  produce(opts: { track: MediaStreamTrack }): Promise<MsProducer>;
  consume(opts: { id: string; producerId: string; kind: 'audio'; rtpParameters: unknown }): Promise<MsConsumer>;
  close(): void;
}
export interface MsProducer {
  rtpSender?: RTCRtpSender;
}
export interface MsConsumer {
  track: MediaStreamTrack;
  rtpReceiver?: RTCRtpReceiver;
}
export interface MsDevice {
  load(opts: { routerRtpCapabilities: unknown }): Promise<void>;
  rtpCapabilities: unknown;
  createSendTransport(opts: unknown): MsTransport;
  createRecvTransport(opts: unknown): MsTransport;
}

export interface CallMediaDeps {
  control: SfuControl;
  /** Fresh mediasoup-client Device (real in app/e2e, fake in unit tests). */
  createDevice: () => MsDevice;
  /** The local mic track (getUserMedia in the app; a fake track in tests). */
  getMicTrack: () => Promise<MediaStreamTrack>;
  /** Called for each remote peer's track (attach to an <audio> in the app). */
  onRemoteTrack?: (track: MediaStreamTrack) => void;
  /** Frame E2EE hooks (insertable streams) — no-op when unsupported/omitted. */
  encryptSender?: (sender: RTCRtpSender) => void;
  decryptReceiver?: (receiver: RTCRtpReceiver) => void;
}

export interface VoiceMedia extends CallMedia {
  /** Consume a newly-announced producer (from the SFU `producer` signal). */
  onProducer(producerId: string): Promise<void>;
}

export function createCallMedia(deps: CallMediaDeps): VoiceMedia {
  let callId: string | null = null;
  let device: MsDevice | null = null;
  let sendTransport: MsTransport | null = null;
  let recvTransport: MsTransport | null = null;
  let micTrack: MediaStreamTrack | null = null;
  const consumed = new Set<string>(); // producer ids already consumed (dedup)

  function wireTransport(id: string, t: MsTransport, direction: 'send' | 'recv'): void {
    t.on('connect', ({ dtlsParameters }, cb, eb) => {
      deps.control.connectTransport(id, t.id, dtlsParameters).then(cb).catch(eb);
    });
    if (direction === 'send') {
      t.on('produce', ({ rtpParameters }, cb, eb) => {
        deps.control
          .produce(id, t.id, rtpParameters)
          .then(({ producerId }) => cb({ id: producerId }))
          .catch(eb);
      });
    }
  }

  async function consumeProducer(producerId: string): Promise<void> {
    if (!callId || !device || !recvTransport || consumed.has(producerId)) return;
    consumed.add(producerId);
    const resp = await deps.control.consume(callId, recvTransport.id, producerId, device.rtpCapabilities);
    const consumer = await recvTransport.consume({ id: resp.id, producerId, kind: 'audio', rtpParameters: resp.rtpParameters });
    if (consumer.rtpReceiver) deps.decryptReceiver?.(consumer.rtpReceiver);
    deps.onRemoteTrack?.(consumer.track);
  }

  async function join(id: string): Promise<void> {
    callId = id;
    const { routerRtpCapabilities, peers } = await deps.control.join(id);
    device = deps.createDevice();
    await device.load({ routerRtpCapabilities });

    sendTransport = device.createSendTransport(await deps.control.createTransport(id, 'send'));
    wireTransport(id, sendTransport, 'send');
    recvTransport = device.createRecvTransport(await deps.control.createTransport(id, 'recv'));
    wireTransport(id, recvTransport, 'recv');

    micTrack = await deps.getMicTrack();
    const producer = await sendTransport.produce({ track: micTrack });
    if (producer.rtpSender) deps.encryptSender?.(producer.rtpSender);

    // Consume anyone already producing when we joined.
    for (const p of peers) if (p.producerId) await consumeProducer(p.producerId);
  }

  async function onProducer(producerId: string): Promise<void> {
    await consumeProducer(producerId);
  }

  function close(): void {
    try {
      micTrack?.stop();
      sendTransport?.close();
      recvTransport?.close();
    } catch {
      /* already closed */
    }
    if (callId) void deps.control.leave(callId).catch(() => {});
    callId = null;
    device = null;
    sendTransport = null;
    recvTransport = null;
    micTrack = null;
    consumed.clear();
  }

  return { join, close, onProducer };
}
