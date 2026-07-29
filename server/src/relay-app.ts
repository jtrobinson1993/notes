import Fastify, { type FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { registerSecurityHeaders } from './security-headers.js';
import { relayRoutes } from './routes/relay.js';
import { relayContentRoutes } from './routes/relayContent.js';
import { createRelayLive } from './relayLive.js';
import { createVoiceSignal } from './voiceSignal.js';
import { createVoiceSfu } from './voiceSfu.js';
import { createKtSidecar } from './ktSidecar.js';
import { createPush } from './push.js';
import { WS_MAX_PAYLOAD } from './util.js';

/**
 * The standalone v8 relay (spec/relay.md): a zero-knowledge message relay that
 * mounts ONLY the `/api/relay/*` surface (device auth, directory + KT, mailbox,
 * blobs, groups, voice signaling/SFU, registration, plus the content
 * proxies for GIF search / link previews / 7TV emotes) and a health probe.
 *
 * The content proxies are here because they are a PRIVACY primitive: the relay
 * makes the outbound request so the client's IP never reaches Klipy, 7TV or an
 * arbitrary link target. See routes/relayContent.ts.
 *
 * Deliberately excludes the entire legacy web-app stack — WebAuthn/sessions,
 * notes/chat/friends REST, admin, the legacy realtime hub,
 * and SPA static serving. The relay is operator-controlled (see the relay CLI),
 * not driven by any frontend, so none of that belongs here. The session-gated
 * `/api/relay/devices` bootstrap endpoints went with the session layer —
 * account creation is `/api/relay/register`, device management is the CLI, and
 * multi-device pairing (D8) will be device-authed.
 */
export async function buildRelayApp(db: DB, config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });

  // API-only hardening headers (no HTML surface → the CSP is a floor, not a
  // live defence; the app's real one is the native webview's).
  registerSecurityHeaders(app, config);

  await app.register(fastifyRateLimit, {
    global: true,
    max: config.rateLimitMax,
    timeWindow: '1 minute',
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: WS_MAX_PAYLOAD } });

  const relayLive = createRelayLive();
  const voiceSignal = createVoiceSignal();
  // The SFU announces new producers over the signaling room so peers consume.
  const voiceSfu = createVoiceSfu(config, voiceSignal.notifyRoom);
  // The relay already gates the content-free push on its own relayLive
  // device-online check (see the mailbox send), so the pusher's presence check
  // is redundant here — an always-offline adapter keeps push decoupled from the
  // legacy realtime hub without changing behavior.
  const push = createPush(db, config, { isOnline: () => false });
  app.addHook('onClose', async () => voiceSfu.close());

  app.get('/api/health', async () => ({ ok: true }));
  const ktSidecar = config.akdSidecarUrl
    ? createKtSidecar(config.akdSidecarUrl, config.akdSidecarToken ?? '')
    : undefined;
  relayRoutes(app, db, relayLive, config, voiceSignal, voiceSfu, ktSidecar, push);
  relayContentRoutes(app, db, config);

  return app;
}
