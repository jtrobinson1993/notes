import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { requireAuth } from '../session.js';

// Default 7TV emote images are no longer committed to the repo. Instead the
// server fetches each one from 7TV's CDN on first request and caches it on disk,
// then serves it from our own origin. That keeps the privacy/offline posture of
// self-hosting (no per-render IP leak to 7TV; service-worker cacheable) while
// dropping ~300 binaries from the repo — the metadata set is refreshed from the
// 7TV API via scripts/fetch-emojis.mjs.

// 7TV emote ids are 26-char Crockford ULIDs; only these may be proxied, and only
// from 7TV's CDN, so this can't be turned into an open proxy.
const FILE_RE = /^([0-9A-HJKMNP-TV-Z]{26})\.webp$/;
const cdnUrl = (id: string) => `https://cdn.7tv.app/emote/${id}/2x.webp`;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 1024 * 1024; // emote WebPs are a few KB; 1 MB is generous.

export function emojiRoutes(app: FastifyInstance, config: Config): void {
  const cacheDir = join(config.dataDir, 'emoji-cache');

  // Explicit per-route limit: this handler hits the disk (and the 7TV CDN on a
  // cache miss), so it gets its own bucket on top of the global limiter. Liberal
  // — emote responses are immutable/long-cached by the browser, so steady-state
  // a client barely touches this; the cap only bites on abusive bulk fetching.
  const rateLimit = { rateLimit: { max: config.rateLimitMax, timeWindow: '1 minute' } };

  app.get('/emoji/7tv/:file', { preHandler: requireAuth, config: rateLimit }, async (request, reply) => {
    const { file } = request.params as { file: string };
    const m = FILE_RE.exec(file);
    if (!m) return reply.code(400).send({ error: 'invalid emote id' });
    const id = m[1]!;
    const path = join(cacheDir, `${id}.webp`);

    let cached = true;
    try {
      await stat(path);
    } catch {
      cached = false;
    }

    if (!cached) {
      let res: Response;
      try {
        res = await fetch(cdnUrl(id), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      } catch {
        return reply.code(502).send({ error: 'emote fetch failed' });
      }
      if (!res.ok) return reply.code(502).send({ error: 'emote unavailable' });
      if (!(res.headers.get('content-type') ?? '').startsWith('image/')) {
        return reply.code(502).send({ error: 'not an image' });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) {
        return reply.code(502).send({ error: 'emote too large' });
      }
      await mkdir(cacheDir, { recursive: true });
      await writeFile(path, buf);
    }

    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    reply.type('image/webp');
    return reply.send(createReadStream(path));
  });
}
