// v8 relay live-delivery hub (spec/relay.md § live delivery). A device-scoped
// WebSocket that carries a single, content-free nudge — `{type:'mail'}` — so a
// connected device can skip polling and immediately run its REST fetch→ack
// loop. The REST mailbox stays authoritative for delivery (hold-until-ack); the
// socket only removes the poll latency, so a dropped or missed nudge is harmless
// (the next fetch, poll, or reconnect still drains the queue).
//
// Auth is the device bearer token ONLY (D4/D4b) — the same credential the
// mailbox fetch requires. There is deliberately no cookie and no Origin check:
// the relay client is native (it sets Authorization on the handshake), and a
// bearer token carries no CSRF surface the way an ambient cookie would. The
// nudge reveals nothing beyond "something was enqueued for you," which the
// owning device is already entitled to learn by polling.

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';

const HEARTBEAT_MS = 30_000;
const MAX_SOCKETS_PER_DEVICE = 4;

interface LiveDevice {
  ws: WebSocket;
  deviceId: string;
  isAlive: boolean;
}

/** Resolve a bearer token to a live device id, or null if it is missing,
 *  invalid, or revoked. Supplied by the relay routes (verifyDeviceToken + db
 *  revocation check) so this hub stays decoupled from auth internals. */
export type DeviceAuth = (token: string | null) => string | null;

export interface RelayLive {
  register(app: FastifyInstance, authenticate: DeviceAuth, rateLimitMax: number): void;
  /** Nudge every currently-connected socket for these devices to fetch. */
  notifyDevices(deviceIds: string[]): void;
  isDeviceOnline(deviceId: string): boolean;
}

export function createRelayLive(): RelayLive {
  // deviceId -> insertion-ordered set of sockets (a device may have >1 window).
  const sockets = new Map<string, Set<LiveDevice>>();

  function isDeviceOnline(deviceId: string): boolean {
    const set = sockets.get(deviceId);
    return !!set && set.size > 0;
  }

  function addSocket(live: LiveDevice): void {
    let set = sockets.get(live.deviceId);
    if (!set) {
      set = new Set();
      sockets.set(live.deviceId, set);
    }
    // Per-device cap: evict the oldest socket first (Set preserves order).
    while (set.size >= MAX_SOCKETS_PER_DEVICE) {
      const oldest = set.values().next().value as LiveDevice | undefined;
      if (!oldest) break;
      set.delete(oldest);
      try {
        oldest.ws.close();
      } catch {
        /* already gone */
      }
    }
    set.add(live);
  }

  function removeSocket(live: LiveDevice): void {
    const set = sockets.get(live.deviceId);
    if (!set) return;
    set.delete(live);
    if (set.size === 0) sockets.delete(live.deviceId);
  }

  function notifyDevices(deviceIds: string[]): void {
    const frame = JSON.stringify({ type: 'mail' });
    const seen = new Set<string>();
    for (const id of deviceIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const set = sockets.get(id);
      if (!set) continue;
      for (const live of set) {
        if (live.ws.readyState === live.ws.OPEN) {
          try {
            live.ws.send(frame);
          } catch {
            /* socket gone; cleanup happens on close */
          }
        }
      }
    }
  }

  function register(app: FastifyInstance, authenticate: DeviceAuth, rateLimitMax: number): void {
    app.get(
      '/api/relay/ws',
      // Rate-limit the upgrade handshake per-IP to cap connection churn.
      {
        websocket: true,
        config: { rateLimit: { max: rateLimitMax, timeWindow: '1 minute' } },
      },
      (socket: WebSocket, request) => {
        const header = request.headers.authorization;
        const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
        const deviceId = authenticate(token);
        if (!deviceId) {
          socket.close();
          return;
        }
        const live: LiveDevice = { ws: socket, deviceId, isAlive: true };
        addSocket(live);
        try {
          socket.send(JSON.stringify({ type: 'hello' }));
        } catch {
          /* ignore */
        }

        socket.on('pong', () => {
          live.isAlive = true;
        });
        // Inbound frames are ignored (liveness is protocol ping/pong); the
        // client has nothing to say here — it fetches over REST.
        socket.on('message', () => {});
        const onGone = (): void => removeSocket(live);
        socket.on('close', onGone);
        socket.on('error', onGone);
      },
    );

    // Heartbeat: terminate sockets that didn't pong since the previous tick.
    const timer = setInterval(() => {
      for (const set of sockets.values()) {
        for (const live of set) {
          if (!live.isAlive) {
            try {
              live.ws.terminate();
            } catch {
              /* ignore */
            }
            continue;
          }
          live.isAlive = false;
          try {
            live.ws.ping();
          } catch {
            /* ignore */
          }
        }
      }
    }, HEARTBEAT_MS);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  return { register, notifyDevices, isDeviceOnline };
}
