import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import type { ServerFrame } from '@notes/shared';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { sha256b64 } from './util.js';
import { SESSION_COOKIE } from './session.js';

const HEARTBEAT_MS = 30_000;
const MAX_SOCKETS_PER_USER = 8;
const MAX_PAYLOAD = 64 * 1024;

interface LiveSocket {
  ws: WebSocket;
  userId: string;
  isAlive: boolean;
}

export interface Realtime {
  register(app: FastifyInstance): void;
  sendToUser(userId: string, frame: ServerFrame): void;
  sendToUsers(userIds: string[], frame: ServerFrame, exceptUserId?: string): void;
  isOnline(userId: string): boolean;
  /** Register a callback fired when a user's last socket closes (fully offline).
   *  Used by voice to tear down a disconnected user's calls. */
  onUserOffline(cb: (userId: string) => void): void;
}

/** In-memory realtime hub: tracks each user's open sockets, fans out frames,
 * heartbeats, and broadcasts presence to friends. Crypto-oblivious: frames
 * carry only opaque ciphertext/metadata. */
export function createRealtime(db: DB, config: Config): Realtime {
  // userId -> insertion-ordered set of live sockets (Map keeps oldest first).
  const sockets = new Map<string, Set<LiveSocket>>();
  const offlineCallbacks: ((userId: string) => void)[] = [];

  function onUserOffline(cb: (userId: string) => void): void {
    offlineCallbacks.push(cb);
  }

  function isOnline(userId: string): boolean {
    const set = sockets.get(userId);
    return !!set && set.size > 0;
  }

  function send(ws: WebSocket, frame: ServerFrame): void {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        /* socket gone; cleanup happens on close */
      }
    }
  }

  function sendToUser(userId: string, frame: ServerFrame): void {
    const set = sockets.get(userId);
    if (!set) return;
    for (const s of set) send(s.ws, frame);
  }

  function sendToUsers(userIds: string[], frame: ServerFrame, exceptUserId?: string): void {
    const seen = new Set<string>();
    for (const id of userIds) {
      if (id === exceptUserId || seen.has(id)) continue;
      seen.add(id);
      sendToUser(id, frame);
    }
  }

  function onlineFriendIds(userId: string): string[] {
    return db.listFriendIds(userId).filter((id) => isOnline(id));
  }

  function addSocket(live: LiveSocket): void {
    let set = sockets.get(live.userId);
    if (!set) {
      set = new Set();
      sockets.set(live.userId, set);
    }
    // Per-user cap: drop the oldest socket(s) first (Set preserves insertion order).
    while (set.size >= MAX_SOCKETS_PER_USER) {
      const oldest = set.values().next().value as LiveSocket | undefined;
      if (!oldest) break;
      set.delete(oldest);
      try {
        oldest.ws.close();
      } catch {
        /* ignore */
      }
    }
    set.add(live);
  }

  function removeSocket(live: LiveSocket): boolean {
    const set = sockets.get(live.userId);
    if (!set) return false;
    const had = set.delete(live);
    if (set.size === 0) sockets.delete(live.userId);
    return had && !isOnline(live.userId);
  }

  function authenticate(req: { headers: Record<string, unknown>; cookies?: Record<string, string> }) {
    // Cross-origin WS guard: browsers always send Origin on WS handshakes, so
    // require a present, matching one (stricter than the REST CSRF check).
    const origin = req.headers.origin as string | undefined;
    if (origin !== config.appOrigin) return null;
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    const session = db.getSession(sha256b64(token));
    if (!session) return null;
    const user = db.getUser(session.user_id);
    if (!user) return null;
    return user;
  }

  function register(app: FastifyInstance): void {
    app.get(
      '/api/ws',
      // Rate-limit the upgrade handshake (per-IP, at the global ceiling) to cap
      // connection churn; the limiter runs in the onRequest hook before upgrade.
      { websocket: true, config: { rateLimit: { max: config.rateLimitMax, timeWindow: '1 minute' } } },
      // The handler signature for @fastify/websocket v11 is (socket, request).
      (socket: WebSocket, request) => {
        const user = authenticate(request as never);
        if (!user) {
          socket.close();
          return;
        }
        const live: LiveSocket = { ws: socket, userId: user.id, isAlive: true };
        addSocket(live);
        const becameOnline = sockets.get(user.id)!.size === 1;

        send(socket, { type: 'hello', userId: user.id });
        if (becameOnline) {
          sendToUsers(onlineFriendIds(user.id), { type: 'presence', userId: user.id, online: true });
        }

        socket.on('pong', () => {
          live.isAlive = true;
        });

        socket.on('message', (raw: Buffer) => {
          // Inbound ClientFrames: only an optional {type:'ping'} is recognised,
          // and it requires no reply (liveness is protocol ping/pong).
          let frame: unknown;
          try {
            frame = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (typeof frame === 'object' && frame && (frame as { type?: string }).type === 'ping') {
            // no-op
          }
        });

        const onGone = (): void => {
          const wentOffline = removeSocket(live);
          if (wentOffline) {
            sendToUsers(onlineFriendIds(user.id), { type: 'presence', userId: user.id, online: false });
            for (const cb of offlineCallbacks) cb(user.id);
          }
        };
        socket.on('close', onGone);
        socket.on('error', onGone);
      },
    );

    // Heartbeat: terminate sockets that didn't pong since the last tick.
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

  return { register, sendToUser, sendToUsers, isOnline, onUserOffline };
}

export const WS_MAX_PAYLOAD = MAX_PAYLOAD;
