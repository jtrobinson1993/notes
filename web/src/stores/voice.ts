import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { Device, type types as msTypes } from 'mediasoup-client';
import type { ServerFrame, VoicePeer } from '@notes/shared';
import { api } from '../lib/api';
import { onFrame } from '../lib/chatSocket';
import { useSessionStore } from './session';
import { generateMediaKey, sealMediaKey, unsealMediaKey } from '../lib/voiceCrypto';
import { decryptReceiver, dropFrameKey, encryptSender, resetVoiceWorker, setFrameKey, setSendEpoch, voiceE2eeSupported } from '../lib/voiceTransform';

// Client orchestration for E2EE voice: mediasoup-client Device + transports,
// produce/consume, media-key handling via WS events, plus the UI-facing roster
// (mute/deafen/PTT, per-peer volume, who's-speaking, connection quality).
//
// Browser-runtime only (mediasoup-client, getUserMedia, WebAudio) — verified by
// manual two-browser testing. The pure pieces it leans on are tested: the room
// state machine (server) and the frame crypto (web/test/crypto).

/** A peer as shown in the call UI. */
export interface UiPeer extends VoicePeer {
  speaking: boolean;
  /** local playback gain 0..1 (per-listener, not sent anywhere) */
  volume: number;
}

interface PeerRuntime {
  consumer?: msTypes.Consumer;
  audio?: HTMLAudioElement;
  analyser?: AnalyserNode;
}

const MIC_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const SPEAKING_THRESHOLD = 0.02; // RMS over [0,1]

export const useVoiceStore = defineStore('voice', () => {
  const session = useSessionStore();

  const activeRoomId = ref<string | null>(null);
  const connecting = ref(false);
  const error = ref<string | null>(null);
  const peers = reactive(new Map<string, UiPeer>());
  const muted = ref(false);
  const deafened = ref(false);
  const pushToTalk = ref(false);
  const localSpeaking = ref(false);
  const connectionQuality = ref<'good' | 'fair' | 'poor' | 'unknown'>('unknown');

  const inCall = computed(() => activeRoomId.value !== null);
  const peerList = computed(() => [...peers.values()]);

  // --- non-reactive runtime (never proxied — mediasoup objects dislike proxies) ---
  let device: Device | null = null;
  let sendTransport: msTypes.Transport | null = null;
  let recvTransport: msTypes.Transport | null = null;
  let producer: msTypes.Producer | null = null;
  let micStream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let localAnalyser: AnalyserNode | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const runtime = new Map<string, PeerRuntime>(); // by userId
  const mediaKeys = new Map<number, Uint8Array>(); // epoch -> raw (owner keeps these to re-seal)
  let currentEpoch = -1;
  let unsub: (() => void) | null = null;

  function reset(): void {
    activeRoomId.value = null;
    peers.clear();
    runtime.clear();
    mediaKeys.clear();
    currentEpoch = -1;
    muted.value = false;
    deafened.value = false;
    localSpeaking.value = false;
    connectionQuality.value = 'unknown';
    device = sendTransport = recvTransport = producer = null;
  }

  function rms(analyser: AnalyserNode): number {
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  }

  // --- transport wiring -----------------------------------------------------
  async function makeTransport(roomId: string, direction: 'send' | 'recv'): Promise<msTypes.Transport> {
    const params = (await api.voiceCreateTransport(roomId, direction)) as unknown as msTypes.TransportOptions;
    const t = direction === 'send' ? device!.createSendTransport(params) : device!.createRecvTransport(params);
    t.on('connect', ({ dtlsParameters }, callback, errback) => {
      api
        .voiceConnectTransport(roomId, { transportId: t.id, dtlsParameters: dtlsParameters as unknown as Record<string, unknown> })
        .then(() => callback())
        .catch(errback);
    });
    if (direction === 'send') {
      t.on('produce', ({ rtpParameters }, callback, errback) => {
        api
          .voiceProduce(roomId, { transportId: t.id, rtpParameters: rtpParameters as unknown as Record<string, unknown> })
          .then(({ producerId }) => callback({ id: producerId }))
          .catch(errback);
      });
    }
    return t;
  }

  async function consumePeer(roomId: string, userId: string, producerId: string): Promise<void> {
    if (!recvTransport || !device) return;
    const resp = await api.voiceConsume(roomId, {
      transportId: recvTransport.id,
      producerId,
      rtpCapabilities: device.rtpCapabilities as unknown as Record<string, unknown>,
    });
    const consumer = await recvTransport.consume({
      id: resp.id,
      producerId,
      kind: 'audio',
      rtpParameters: resp.rtpParameters as unknown as msTypes.RtpParameters,
    });
    if (consumer.rtpReceiver) decryptReceiver(consumer.rtpReceiver);

    const stream = new MediaStream([consumer.track]);
    const audio = new Audio();
    audio.srcObject = stream;
    audio.autoplay = true;
    const peer = peers.get(userId);
    audio.volume = peer?.volume ?? 1;
    audio.muted = deafened.value;
    void audio.play().catch(() => {/* autoplay may need a gesture; UI prompts */});

    const rt = runtime.get(userId) ?? {};
    rt.consumer = consumer;
    rt.audio = audio;
    if (audioCtx) {
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      rt.analyser = analyser;
    }
    runtime.set(userId, rt);
  }

  // --- media-key handling ---------------------------------------------------
  async function onKeyEpoch(epoch: number, rawKey: Uint8Array): Promise<void> {
    mediaKeys.set(epoch, rawKey);
    setFrameKey(epoch, rawKey);
    if (epoch >= currentEpoch) {
      currentEpoch = epoch;
      setSendEpoch(epoch);
    }
    // forget keys well behind the current epoch
    for (const e of mediaKeys.keys()) if (e < currentEpoch - 1) {
      mediaKeys.delete(e);
      dropFrameKey(e);
    }
  }

  async function authorRekey(roomId: string, epoch: number, roster: { userId: string; publicKey: string }[]): Promise<void> {
    const raw = generateMediaKey();
    const keys = await Promise.all(roster.map(async (m) => ({ userId: m.userId, sealedKey: await sealMediaKey(m.publicKey, raw) })));
    await onKeyEpoch(epoch, raw); // apply locally immediately (I generated it)
    await api.voiceRekey(roomId, epoch, keys);
  }

  // --- frame handling -------------------------------------------------------
  async function handleFrame(frame: ServerFrame): Promise<void> {
    const roomId = activeRoomId.value;
    if (!roomId) return;
    switch (frame.type) {
      case 'voice-peer-joined':
        if (frame.roomId === roomId && frame.peer.userId !== session.user?.id) {
          peers.set(frame.peer.userId, { ...frame.peer, speaking: false, volume: 1 });
        }
        break;
      case 'voice-peer-left':
        if (frame.roomId === roomId) removePeer(frame.userId);
        break;
      case 'voice-new-producer':
        if (frame.roomId === roomId && frame.userId !== session.user?.id) {
          const p = peers.get(frame.userId);
          if (p) p.producerId = frame.producerId;
          await consumePeer(roomId, frame.userId, frame.producerId);
        }
        break;
      case 'voice-key-epoch':
        if (frame.roomId === roomId) {
          const { privateKey, publicKey } = await session.getKeyPair();
          await onKeyEpoch(frame.epoch, await unsealMediaKey(frame.sealedKey, privateKey, publicKey));
        }
        break;
      case 'voice-rekey-needed':
        if (frame.roomId === roomId) await authorRekey(roomId, frame.epoch, frame.roster);
        break;
      default:
        break;
    }
  }

  function removePeer(userId: string): void {
    const rt = runtime.get(userId);
    if (rt) {
      try {
        rt.consumer?.close();
        if (rt.audio) {
          rt.audio.srcObject = null;
        }
      } catch {/* ignore */}
      runtime.delete(userId);
    }
    peers.delete(userId);
  }

  // --- public actions -------------------------------------------------------
  async function join(roomId: string): Promise<void> {
    if (activeRoomId.value === roomId) return;
    if (!voiceE2eeSupported()) {
      error.value = 'Your browser does not support end-to-end-encrypted voice.';
      return;
    }
    if (activeRoomId.value) await leave();
    connecting.value = true;
    error.value = null;
    try {
      const resp = await api.voiceJoin(roomId);
      activeRoomId.value = roomId;
      device = new Device();
      await device.load({ routerRtpCapabilities: resp.routerRtpCapabilities as unknown as msTypes.RtpCapabilities });

      for (const p of resp.peers) peers.set(p.userId, { ...p, speaking: false, volume: 1 });
      const { privateKey, publicKey } = await session.getKeyPair();
      for (const k of resp.mediaKeys) await onKeyEpoch(k.epoch, await unsealMediaKey(k.sealedKey, privateKey, publicKey));

      audioCtx = new AudioContext();
      sendTransport = await makeTransport(roomId, 'send');
      recvTransport = await makeTransport(roomId, 'recv');

      micStream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
      const track = micStream.getAudioTracks()[0]!;
      producer = await sendTransport.produce({ track });
      if (producer.rtpSender) encryptSender(producer.rtpSender);
      const micSrc = audioCtx.createMediaStreamSource(micStream);
      localAnalyser = audioCtx.createAnalyser();
      localAnalyser.fftSize = 512;
      micSrc.connect(localAnalyser);

      // consume peers already producing
      for (const p of resp.peers) if (p.producerId) await consumePeer(roomId, p.userId, p.producerId);

      startPolling();
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to join voice';
      await leave();
    } finally {
      connecting.value = false;
    }
  }

  async function leave(): Promise<void> {
    const roomId = activeRoomId.value;
    stopPolling();
    for (const userId of [...runtime.keys()]) removePeer(userId);
    try {
      producer?.close();
      sendTransport?.close();
      recvTransport?.close();
      micStream?.getTracks().forEach((t) => t.stop());
      await audioCtx?.close();
    } catch {/* ignore */}
    micStream = null;
    audioCtx = null;
    localAnalyser = null;
    resetVoiceWorker();
    reset();
    if (roomId) {
      try {
        await api.voiceLeave(roomId);
      } catch {/* best-effort */}
    }
  }

  function applyMicEnabled(): void {
    const track = micStream?.getAudioTracks()[0];
    if (track) track.enabled = !muted.value && !deafened.value && !(pushToTalk.value && !pttHeld);
  }

  let pttHeld = false;
  function setMuted(v: boolean): void {
    muted.value = v;
    applyMicEnabled();
  }
  function toggleMute(): void {
    setMuted(!muted.value);
  }
  function setDeafened(v: boolean): void {
    deafened.value = v;
    for (const rt of runtime.values()) if (rt.audio) rt.audio.muted = v;
    applyMicEnabled();
  }
  function toggleDeafen(): void {
    setDeafened(!deafened.value);
  }
  function setPushToTalk(on: boolean): void {
    pushToTalk.value = on;
    applyMicEnabled();
  }
  function setPttHeld(held: boolean): void {
    pttHeld = held;
    applyMicEnabled();
  }
  function setVolume(userId: string, volume: number): void {
    const peer = peers.get(userId);
    if (peer) peer.volume = volume;
    const rt = runtime.get(userId);
    if (rt?.audio) rt.audio.volume = volume;
  }

  // --- speaking detection + connection quality ------------------------------
  function startPolling(): void {
    pollTimer = setInterval(() => {
      if (localAnalyser) {
        const active = !muted.value && rms(localAnalyser) > SPEAKING_THRESHOLD;
        localSpeaking.value = active;
      }
      for (const [userId, rt] of runtime) {
        const peer = peers.get(userId);
        if (peer && rt.analyser) peer.speaking = rms(rt.analyser) > SPEAKING_THRESHOLD;
      }
      void pollQuality();
    }, 200);
  }
  function stopPolling(): void {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }
  async function pollQuality(): Promise<void> {
    if (!sendTransport) return;
    try {
      const stats = await sendTransport.getStats();
      let loss = 0;
      stats.forEach((r: { type?: string; fractionLost?: number }) => {
        if (r.type === 'remote-inbound-rtp' && typeof r.fractionLost === 'number') loss = Math.max(loss, r.fractionLost);
      });
      connectionQuality.value = loss < 0.03 ? 'good' : loss < 0.1 ? 'fair' : 'poor';
    } catch {
      connectionQuality.value = 'unknown';
    }
  }

  /** Subscribe to voice WS frames (idempotent). Call once at app start. */
  function init(): void {
    if (unsub) return;
    unsub = onFrame((frame) => void handleFrame(frame));
  }

  return {
    activeRoomId,
    connecting,
    error,
    peers,
    peerList,
    muted,
    deafened,
    pushToTalk,
    localSpeaking,
    connectionQuality,
    inCall,
    init,
    join,
    leave,
    toggleMute,
    setMuted,
    toggleDeafen,
    setDeafened,
    setPushToTalk,
    setPttHeld,
    setVolume,
  };
});
