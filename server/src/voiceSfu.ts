// v8 voice SFU (spec/voice.md § v8). The media half of v8 1:1 calls: a mediasoup
// SFU whose rooms are keyed by an unguessable **call id** and authorized by the
// **device token** — NOT the server-side social graph the legacy voice.ts uses
// (`resolveRoom` → conversation/channel membership), which cannot exist under
// v8's graph-hiding relay. Media flows through the SFU so neither caller learns
// the other's IP (the spec's privacy property). Frame content is E2E-sealed by
// the clients (insertable streams); the SFU only ever relays ciphertext RTP and
// never sees a media key, so this module has no key/rekey machinery at all
// (unlike v6, whose owner-rekey scheme sealed keys over the legacy hub).
//
// This first slice: the room registry + capability-authed `join` (returns the
// router RTP capabilities + the peer roster to consume). Transport / connect /
// produce / consume / leave land in following slices, mirroring voice.ts but
// capability-scoped.

import * as mediasoup from 'mediasoup';
import type { types } from 'mediasoup';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { DeviceAuth } from './relayLive.js';
import { newToken } from './util.js';

// Opus only, matching v6 (stereo @ 48 kHz WebRTC default; PT in the dynamic range).
const MEDIA_CODECS: types.RtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', preferredPayloadType: 100, clockRate: 48000, channels: 2 },
];
const CALL_ID_RE = /^[A-Za-z0-9_-]{8,128}$/; // the unguessable capability token
const MAX_PEERS_PER_CALL = 8; // 1:1 uses 2; caps a leaked call id (mirrors voiceSignal)

interface SfuConn {
  /** Ephemeral per-join id shown to peers — never the stable device id. */
  participantId: string;
  sendTransport?: types.WebRtcTransport;
  recvTransport?: types.WebRtcTransport;
  producer?: types.Producer;
  producerId: string | null;
  consumers: Map<string, types.Consumer>;
}

export interface VoiceSfu {
  register(app: FastifyInstance, authenticate: DeviceAuth, rateLimitMax: number): void;
  close(): Promise<void>;
}

/** Announce a new producer to a call's other devices (over the signaling room),
 *  so they consume it. Injected from the voice signaling hub. */
export type ProducerNotifier = (callId: string, frame: object, exceptDeviceId?: string) => void;

export function createVoiceSfu(config: Config, notify?: ProducerNotifier): VoiceSfu {
  // Lazily created on first join — the worker (a child process) never starts in
  // deployments/tests that don't use voice.
  let workerPromise: Promise<types.Worker> | null = null;
  const routers = new Map<string, types.Router>();
  const conns = new Map<string, SfuConn>(); // key: `${callId} ${deviceId}`
  const rooms = new Map<string, Set<string>>(); // callId -> deviceIds

  const ck = (callId: string, deviceId: string): string => `${callId} ${deviceId}`;

  function getWorker(): Promise<types.Worker> {
    if (!workerPromise) {
      workerPromise = mediasoup.createWorker({
        rtcMinPort: config.voice.rtcMinPort,
        rtcMaxPort: config.voice.rtcMaxPort,
        logLevel: 'warn',
      });
    }
    return workerPromise;
  }

  async function getRouter(callId: string): Promise<types.Router> {
    let router = routers.get(callId);
    if (!router) {
      const worker = await getWorker();
      router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
      routers.set(callId, router);
    }
    return router;
  }

  /** Resolve the request's device-token bearer to a device id, or null. */
  function deviceOf(request: FastifyRequest, authenticate: DeviceAuth): string | null {
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    return authenticate(token);
  }

  function isMember(callId: string, deviceId: string): boolean {
    return rooms.get(callId)?.has(deviceId) ?? false;
  }

  function findTransport(callId: string, deviceId: string, transportId: string): types.WebRtcTransport | undefined {
    const conn = conns.get(ck(callId, deviceId));
    if (conn?.sendTransport?.id === transportId) return conn.sendTransport;
    if (conn?.recvTransport?.id === transportId) return conn.recvTransport;
    return undefined;
  }

  /** Close a device's media state and drop it from the room; close the router
   *  when the room empties. Shared by the leave endpoint and (later) disconnect. */
  function doLeave(callId: string, deviceId: string): void {
    const conn = conns.get(ck(callId, deviceId));
    if (conn) {
      try {
        conn.sendTransport?.close();
        conn.recvTransport?.close();
      } catch {
        /* already closed */
      }
      conns.delete(ck(callId, deviceId));
    }
    const members = rooms.get(callId);
    members?.delete(deviceId);
    if (members && members.size === 0) {
      rooms.delete(callId);
      const router = routers.get(callId);
      if (router) {
        try {
          router.close();
        } catch {
          /* ignore */
        }
        routers.delete(callId);
      }
    }
  }

  function register(app: FastifyInstance, authenticate: DeviceAuth, rateLimitMax: number): void {
    const rate = { config: { rateLimit: { max: rateLimitMax, timeWindow: '1 minute' } } };

    // ---- Join a call's SFU room: capability-authed, returns caps + roster ----
    app.post('/api/relay/voice/rooms/:callId/join', rate, async (request, reply) => {
      const deviceId = deviceOf(request, authenticate);
      if (!deviceId) return reply.code(401).send({ error: 'device token required' });
      const { callId } = request.params as { callId: string };
      if (!CALL_ID_RE.test(callId)) return reply.code(400).send({ error: 'bad call id' });

      let members = rooms.get(callId);
      const already = members?.has(deviceId) ?? false;
      if (!already && (members?.size ?? 0) >= MAX_PEERS_PER_CALL) {
        return reply.code(409).send({ error: 'call full' });
      }
      const router = await getRouter(callId);
      if (!members) {
        members = new Set();
        rooms.set(callId, members);
      }
      members.add(deviceId);
      if (!conns.has(ck(callId, deviceId))) {
        conns.set(ck(callId, deviceId), { participantId: newToken(), producerId: null, consumers: new Map() });
      }

      // Roster: the *other* participants' ephemeral ids + producer ids (what a
      // client needs to consume them). No device ids or user identities leak.
      const peers = [...members]
        .filter((d) => d !== deviceId)
        .map((d) => {
          const c = conns.get(ck(callId, d));
          return { participantId: c?.participantId ?? '', producerId: c?.producerId ?? null };
        });

      return { callId, routerRtpCapabilities: router.rtpCapabilities, peers };
    });

    // Shared guard for the media endpoints: device token + current membership.
    const member = (request: FastifyRequest): { callId: string; deviceId: string } | null => {
      const deviceId = deviceOf(request, authenticate);
      if (!deviceId) return null;
      const { callId } = request.params as { callId: string };
      if (!CALL_ID_RE.test(callId) || !isMember(callId, deviceId)) return null;
      return { callId, deviceId };
    };

    // ---- Create a WebRtcTransport (send or recv) ----
    app.post('/api/relay/voice/rooms/:callId/transport', rate, async (request, reply) => {
      const m = member(request);
      if (!m) return reply.code(401).send({ error: 'not in call' });
      const { direction } = (request.body ?? {}) as { direction?: string };
      if (direction !== 'send' && direction !== 'recv') return reply.code(400).send({ error: 'invalid direction' });

      const router = await getRouter(m.callId);
      const transport = await router.createWebRtcTransport({
        listenInfos: [
          { protocol: 'udp', ip: config.voice.listenIp, announcedAddress: config.voice.announcedIp },
          { protocol: 'tcp', ip: config.voice.listenIp, announcedAddress: config.voice.announcedIp },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });
      const conn = conns.get(ck(m.callId, m.deviceId))!;
      if (direction === 'send') conn.sendTransport = transport;
      else conn.recvTransport = transport;

      return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      };
    });

    // ---- Connect a transport (DTLS handshake) ----
    app.post('/api/relay/voice/rooms/:callId/transport/connect', rate, async (request, reply) => {
      const m = member(request);
      if (!m) return reply.code(401).send({ error: 'not in call' });
      const { transportId, dtlsParameters } = (request.body ?? {}) as {
        transportId?: string;
        dtlsParameters?: unknown;
      };
      const transport = transportId ? findTransport(m.callId, m.deviceId, transportId) : undefined;
      if (!transport) return reply.code(404).send({ error: 'no transport' });
      await transport.connect({ dtlsParameters: dtlsParameters as types.DtlsParameters });
      return { ok: true };
    });

    // ---- Produce: start sending mic audio (ciphertext RTP; frames E2E-sealed) ----
    app.post('/api/relay/voice/rooms/:callId/produce', rate, async (request, reply) => {
      const m = member(request);
      if (!m) return reply.code(401).send({ error: 'not in call' });
      const { transportId, rtpParameters } = (request.body ?? {}) as {
        transportId?: string;
        rtpParameters?: unknown;
      };
      const conn = conns.get(ck(m.callId, m.deviceId));
      if (!conn?.sendTransport || conn.sendTransport.id !== transportId) {
        return reply.code(404).send({ error: 'no send transport' });
      }
      const producer = await conn.sendTransport.produce({ kind: 'audio', rtpParameters: rtpParameters as types.RtpParameters });
      conn.producer = producer;
      conn.producerId = producer.id;
      // Tell the call's other devices to consume this producer (over the
      // signaling room). Rides a `signal` frame so the native client forwards it.
      notify?.(
        m.callId,
        { type: 'signal', callId: m.callId, payload: { kind: 'producer', producerId: producer.id, participantId: conn.participantId } },
        m.deviceId,
      );
      return { producerId: producer.id };
    });

    // ---- Consume: start receiving one peer's audio by producer id ----
    app.post('/api/relay/voice/rooms/:callId/consume', rate, async (request, reply) => {
      const m = member(request);
      if (!m) return reply.code(401).send({ error: 'not in call' });
      const { transportId, producerId, rtpCapabilities } = (request.body ?? {}) as {
        transportId?: string;
        producerId?: string;
        rtpCapabilities?: unknown;
      };
      const conn = conns.get(ck(m.callId, m.deviceId));
      if (!conn?.recvTransport || conn.recvTransport.id !== transportId) {
        return reply.code(404).send({ error: 'no recv transport' });
      }
      const router = await getRouter(m.callId);
      const caps = rtpCapabilities as types.RtpCapabilities;
      if (!producerId || !router.canConsume({ producerId, rtpCapabilities: caps })) {
        return reply.code(400).send({ error: 'cannot consume' });
      }
      const consumer = await conn.recvTransport.consume({ producerId, rtpCapabilities: caps, paused: false });
      conn.consumers.set(producerId, consumer);
      return { id: consumer.id, producerId, rtpParameters: consumer.rtpParameters };
    });

    // ---- Leave: release media state, drop from the room ----
    app.post('/api/relay/voice/rooms/:callId/leave', rate, async (request, reply) => {
      const m = member(request);
      if (!m) return reply.code(401).send({ error: 'not in call' });
      doLeave(m.callId, m.deviceId);
      return { ok: true };
    });
  }

  async function close(): Promise<void> {
    for (const router of routers.values()) {
      try {
        router.close();
      } catch {
        /* ignore */
      }
    }
    routers.clear();
    conns.clear();
    rooms.clear();
    if (workerPromise) {
      try {
        (await workerPromise).close();
      } catch {
        /* ignore */
      }
      workerPromise = null;
    }
  }

  return { register, close };
}
