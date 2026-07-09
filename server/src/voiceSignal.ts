// v8 voice signaling relay (spec/voice.md § v8). A device-token-authed
// WebSocket that relays *opaque, end-to-end-sealed* signaling frames between the
// devices in a call, keyed by an unguessable call id. This is the dedicated v8
// signaling socket (chosen over bolting onto the legacy cookie-authed /api/ws)
// so it survives the D12 cutover unchanged — the legacy realtime hub can be
// deleted without touching voice.
//
// Trust model: the relay learns only which authenticated devices share a call
// id (unavoidable for live routing — the same "the SFU sees both parties are in
// a call" fact). It never sees identities in cleartext, nor the SDP/ICE payload,
// which the peers seal end-to-end. A *leaked* call id cannot eavesdrop: payloads
// are sealed to the intended peer's key, so a stranger who joins a room gets
// ciphertext it cannot decrypt and cannot forge valid frames into; the per-call
// member cap is defense-in-depth on top of that.
//
// Single-relay first: the initial ring (call id + sealed offer) rides the
// existing sealed-sender mailbox; cross-relay fan-out + call-id dedup is a
// deliberate follow-up (see the privacy analysis in spec/voice.md).

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { DeviceAuth } from './relayLive.js';

const HEARTBEAT_MS = 30_000;
const MAX_CALLS_PER_SOCKET = 8; // a device shouldn't be in many calls at once
const MAX_PEERS_PER_CALL = 8; // 1:1 uses 2; small groups fit; caps a leaked id
const MAX_FRAME_BYTES = 64 * 1024; // SDP/ICE is small; reject oversized abuse
const CALL_ID_RE = /^[A-Za-z0-9_-]{8,128}$/; // high-entropy capability token

interface VoiceSocket {
  ws: WebSocket;
  deviceId: string;
  isAlive: boolean;
  calls: Set<string>;
}

export interface VoiceSignal {
  register(app: FastifyInstance, authenticate: DeviceAuth, rateLimitMax: number): void;
}

export function createVoiceSignal(): VoiceSignal {
  // callId -> the sockets currently joined to that call's signaling room.
  const rooms = new Map<string, Set<VoiceSocket>>();
  // Every connected socket (joined or not) — the heartbeat set.
  const all = new Set<VoiceSocket>();

  function peersOf(callId: string): Set<VoiceSocket> {
    let set = rooms.get(callId);
    if (!set) {
      set = new Set();
      rooms.set(callId, set);
    }
    return set;
  }

  function sendTo(sock: VoiceSocket, frame: object): void {
    if (sock.ws.readyState !== sock.ws.OPEN) return;
    try {
      sock.ws.send(JSON.stringify(frame));
    } catch {
      /* socket gone; cleanup happens on close */
    }
  }

  /** Relay a frame to every *other* member of a call. */
  function relayToPeers(callId: string, from: VoiceSocket, frame: object): void {
    const set = rooms.get(callId);
    if (!set) return;
    for (const peer of set) if (peer !== from) sendTo(peer, frame);
  }

  function leave(sock: VoiceSocket, callId: string): void {
    const set = rooms.get(callId);
    if (!set || !set.has(sock)) return;
    set.delete(sock);
    sock.calls.delete(callId);
    relayToPeers(callId, sock, { type: 'peer-leave', callId });
    if (set.size === 0) rooms.delete(callId);
  }

  function leaveAll(sock: VoiceSocket): void {
    for (const callId of [...sock.calls]) leave(sock, callId);
  }

  function handleJoin(sock: VoiceSocket, callId: string): void {
    if (sock.calls.has(callId)) return; // idempotent
    if (sock.calls.size >= MAX_CALLS_PER_SOCKET) {
      sendTo(sock, { type: 'error', callId, error: 'too many calls' });
      return;
    }
    const set = peersOf(callId);
    if (set.size >= MAX_PEERS_PER_CALL) {
      sendTo(sock, { type: 'error', callId, error: 'call full' });
      if (set.size === 0) rooms.delete(callId);
      return;
    }
    relayToPeers(callId, sock, { type: 'peer-join', callId }); // tell existing peers
    set.add(sock);
    sock.calls.add(callId);
    sendTo(sock, { type: 'joined', callId, peers: set.size - 1 });
  }

  function register(app: FastifyInstance, authenticate: DeviceAuth, rateLimitMax: number): void {
    app.get(
      '/api/relay/voice',
      { websocket: true, config: { rateLimit: { max: rateLimitMax, timeWindow: '1 minute' } } },
      (socket: WebSocket, request) => {
        const header = request.headers.authorization;
        const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
        const deviceId = authenticate(token);
        if (!deviceId) {
          socket.close();
          return;
        }
        const sock: VoiceSocket = { ws: socket, deviceId, isAlive: true, calls: new Set() };
        all.add(sock);
        sendTo(sock, { type: 'hello' });

        socket.on('pong', () => {
          sock.isAlive = true;
        });

        socket.on('message', (raw: Buffer) => {
          if (raw.length > MAX_FRAME_BYTES) return;
          let frame: { type?: string; callId?: unknown; payload?: unknown };
          try {
            frame = JSON.parse(raw.toString());
          } catch {
            return;
          }
          const callId = typeof frame.callId === 'string' ? frame.callId : null;
          switch (frame.type) {
            case 'ping':
              return;
            case 'join':
              if (callId && CALL_ID_RE.test(callId)) handleJoin(sock, callId);
              return;
            case 'leave':
              if (callId) leave(sock, callId);
              return;
            case 'signal':
              // Only relay for a call this socket actually joined — a device
              // can't spray frames into rooms it isn't part of.
              if (callId && sock.calls.has(callId)) {
                relayToPeers(callId, sock, { type: 'signal', callId, payload: frame.payload });
              }
              return;
            default:
              return;
          }
        });

        const onGone = (): void => {
          leaveAll(sock);
          all.delete(sock);
        };
        socket.on('close', onGone);
        socket.on('error', onGone);
      },
    );

    // Heartbeat: terminate sockets that didn't pong since the previous tick.
    const timer = setInterval(() => {
      for (const sock of all) {
        if (!sock.isAlive) {
          try {
            sock.ws.terminate();
          } catch {
            /* ignore */
          }
          continue;
        }
        sock.isAlive = false;
        try {
          sock.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, HEARTBEAT_MS);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  return { register };
}
