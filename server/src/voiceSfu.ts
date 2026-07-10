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

export function createVoiceSfu(config: Config): VoiceSfu {
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
