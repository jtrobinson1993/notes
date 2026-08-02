// Relay content proxies: GIF search, link previews (Open Graph) and 7TV emotes.
//
// These are the three places the app needs third-party content, and they all
// live on the relay for ONE reason: the client's IP must never reach Klipy,
// 7TV, or an arbitrary link target. The relay makes the outbound request and
// hands back normalized data (and, for emotes, cached bytes from its own
// origin). Everything the user actually says stays E2E-encrypted — the relay
// only ever sees a search term or a URL at proxy time.
//
// Auth model
// ----------
// * `/api/relay/gifs/*`, `/api/relay/og`, `/api/relay/emotes/search` are gated
//   on the device bearer token, exactly like the rest of routes/relay.ts. An
//   unauthenticated /og in particular would be SSRF-as-a-service, and an
//   unauthenticated GIF proxy burns the operator's Klipy quota.
// * `/api/relay/emote/:sig/:file` (the image) is `<img src>`-friendly and so
//   CANNOT carry an Authorization header. It is instead gated on an unguessable
//   capability: a 132-bit HMAC over the emote id, keyed by a secret derived from
//   the relay's pinned identity key. Only the AUTHED search endpoint mints those
//   URLs, so a stranger can't turn the relay into a general 7TV mirror even
//   though 7TV ids are public. A valid device bearer token is accepted as an
//   alternative, so the native core can fetch images without a search round-trip.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { EmoteSearchResponse, EmoteSearchResult } from '@notes/shared';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { deviceFromAuthHeader } from '../relayAuth.js';
import { fetchLinkPreview, OG_MAX_URL } from '../linkPreview.js';
import {
  klipyCustomerId,
  klipyProxy,
  MAX_GIF_QUERY,
  parseGifPage,
} from '../gifSearch.js';
import {
  EMOTE_FILE_RE,
  emoteStream,
  ensureEmoteCached,
  MAX_EMOTE_LIMIT,
  MAX_EMOTE_QUERY,
  searchEmotes,
} from '../emotes.js';

/** Bytes of HMAC (base64url) kept in an emote capability path. 22 chars of
 *  base64url ≈ 132 bits — far past guessable, still a short URL. */
const CAP_LEN = 22;
const DEFAULT_EMOTE_LIMIT = 60;

function bucket(max: number, divisor: number): { rateLimit: { max: number; timeWindow: string } } {
  return { rateLimit: { max: Math.max(1, Math.ceil(max / divisor)), timeWindow: '1 minute' } };
}

export function relayContentRoutes(app: FastifyInstance, db: DB, config: Config): void {
  // Stable across restarts (the secret is persisted), so minted emote URLs stay
  // valid and the browser's year-long cache entry isn't invalidated by a relay
  // restart. Its own random secret rather than a derivation of the relay's
  // signing key: rotating the online key must not silently 403 every cached
  // emote URL, and a signing key should not double as an HMAC key.
  const capSecret = createHmac('sha256', db.relayLocalSecret('emote-capability'))
    .update('accord:emote-capability:v1')
    .digest();

  const emoteCap = (id: string): string =>
    createHmac('sha256', capSecret).update(`emote:${id}`).digest('base64url').slice(0, CAP_LEN);

  const capMatches = (id: string, presented: string): boolean => {
    const a = Buffer.from(presented);
    const b = Buffer.from(emoteCap(id));
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const emoteUrl = (id: string): string => `/api/relay/emote/${emoteCap(id)}/${id}.webp`;

  /** Device-token gate, mirroring routes/relay.ts. */
  const authed = (headers: { authorization?: string | string[] }) =>
    deviceFromAuthHeader(headers.authorization, db);

  // Own buckets on top of the global per-IP limiter: each of these makes an
  // OUTBOUND request, so the abuse ceiling has to be lower than "any API call".
  // Expressed as a fraction of the operator's ceiling so a relay tuned up/down
  // scales these with it (same pattern as the legacy auth ceremony).
  const gifRate = { config: bucket(config.rateLimitMax, 10) }; // 60/min at the default 600
  const ogRate = { config: bucket(config.rateLimitMax, 20) }; // 30/min — the SSRF surface
  const emoteSearchRate = { config: bucket(config.rateLimitMax, 10) };
  const emoteImageRate = { config: bucket(config.rateLimitMax, 1) };

  // ---- GIF search (Klipy) ----

  const gifHandler = (kind: 'search' | 'trending') =>
    async function handler(
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) {
      const device = authed(request.headers);
      if (!device) return reply.code(401).send({ error: 'device token required' });
      if (!config.klipyApiKey) return reply.code(503).send({ error: 'gif search disabled' });
      const { q, pos } = request.query as { q?: string; pos?: string };
      let query: string | undefined;
      if (kind === 'search') {
        query = (q ?? '').trim();
        if (!query) return reply.code(400).send({ error: 'missing query' });
        if (query.length > MAX_GIF_QUERY) return reply.code(400).send({ error: 'query too long' });
      }
      try {
        return await klipyProxy(
          config.klipyApiKey,
          kind,
          parseGifPage(pos),
          klipyCustomerId(device.userId),
          query,
        );
      } catch (err) {
        // Log the failure, never the query (search terms are user content).
        request.log.warn({ err: (err as Error).message }, `klipy ${kind} failed`);
        return reply.code(502).send({ error: 'gif provider unavailable' });
      }
    };

  app.get('/api/relay/gifs/search', gifRate, gifHandler('search'));
  app.get('/api/relay/gifs/trending', gifRate, gifHandler('trending'));

  // ---- Link preview (Open Graph), SSRF-guarded ----

  app.get('/api/relay/og', ogRate, async (request, reply) => {
    if (!authed(request.headers)) return reply.code(401).send({ error: 'device token required' });
    const url = (request.query as { url?: string })?.url;
    if (typeof url !== 'string' || url.length > OG_MAX_URL) {
      return reply.code(400).send({ error: 'invalid url' });
    }
    const outcome = await fetchLinkPreview(url);
    if (outcome.ok) return outcome.preview;
    switch (outcome.reason) {
      case 'invalid-url':
        return reply.code(400).send({ error: 'invalid url' });
      case 'unsupported-scheme':
        return reply.code(400).send({ error: 'unsupported scheme' });
      case 'no-preview':
        return reply.code(404).send({ error: 'no preview' });
      default:
        return reply.code(502).send({ error: 'could not fetch preview' });
    }
  });

  // ---- 7TV emotes ----

  app.get('/api/relay/emotes/search', emoteSearchRate, async (request, reply) => {
    if (!authed(request.headers)) return reply.code(401).send({ error: 'device token required' });
    const { q, page, limit } = request.query as { q?: string; page?: string; limit?: string };
    const query = (q ?? '').trim();
    if (query.length > MAX_EMOTE_QUERY) return reply.code(400).send({ error: 'query too long' });
    const pageNum = parseGifPage(page); // same 1..1000 clamp
    const n = Number(limit);
    const lim = Number.isInteger(n) && n >= 1 && n <= MAX_EMOTE_LIMIT ? n : DEFAULT_EMOTE_LIMIT;
    let emotes;
    try {
      emotes = await searchEmotes(query, pageNum, lim);
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, '7tv search failed');
      return reply.code(502).send({ error: 'emote provider unavailable' });
    }
    const results: EmoteSearchResult[] = emotes.map((e) => ({ ...e, url: emoteUrl(e.id) }));
    const body: EmoteSearchResponse = {
      results,
      next: emotes.length >= lim ? String(pageNum + 1) : null,
    };
    return body;
  });

  const cacheDir = join(config.dataDir, 'emoji-cache');

  app.get('/api/relay/emote/:sig/:file', emoteImageRate, async (request, reply) => {
    const { sig, file } = request.params as { sig: string; file: string };
    const m = EMOTE_FILE_RE.exec(file);
    if (!m) return reply.code(400).send({ error: 'invalid emote id' });
    const id = m[1]!;
    // Either credential is enough: the capability (so <img src> works) or a
    // device token (so the native core can fetch directly).
    if (!capMatches(id, sig) && !authed(request.headers)) {
      return reply.code(403).send({ error: 'invalid emote capability' });
    }

    const outcome = await ensureEmoteCached(cacheDir, id);
    if (!outcome.ok) {
      if (outcome.reason === 'invalid-id') return reply.code(400).send({ error: 'invalid emote id' });
      return reply.code(502).send({ error: `emote ${outcome.reason}` });
    }
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.type('image/webp');
    return reply.send(emoteStream(outcome.path));
  });
}
