import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import type { GifSearchResult, GifSearchResponse } from '@notes/shared';
import type { Config } from '../config.js';
import { requireAuth } from '../session.js';

// Server-side proxy for KLIPY GIF search. The API key stays on the server (never
// shipped to the browser); the chosen GIF's CDN URL is what the client embeds
// inside the encrypted message. Search queries transit our (trusted) server;
// message content stays opaque to it. See spec/chat.md + spec/security.md.

const KLIPY_BASE = 'https://api.klipy.com/api/v1';
const PER_PAGE = 24;
const MAX_QUERY = 100;

// KLIPY serves several sizes (hd/md/sm/xs) × formats (webp/gif/mp4/…). Prefer
// animated webp (far smaller than gif) and fall back to gif.
interface Media {
  url?: string;
  width?: number;
  height?: number;
}
type FileBuckets = Record<string, Record<string, Media> | undefined>;

function pickMedia(file: FileBuckets, sizes: string[], formats: string[]): Media | null {
  for (const s of sizes) {
    const bucket = file?.[s];
    if (!bucket) continue;
    for (const f of formats) {
      const m = bucket[f];
      if (m?.url) return m;
    }
  }
  return null;
}

function normalize(raw: unknown): GifSearchResponse {
  const root = (raw ?? {}) as { data?: { data?: unknown[]; has_next?: boolean; current_page?: number } };
  const data = root.data ?? {};
  const items = Array.isArray(data.data) ? data.data : [];
  const results: GifSearchResult[] = [];
  for (const it of items) {
    const item = it as { id?: number | string; slug?: string; title?: string; file?: FileBuckets };
    const file = item.file ?? {};
    const main = pickMedia(file, ['md', 'sm', 'hd'], ['webp', 'gif']);
    if (!main?.url || main.width == null || main.height == null) continue;
    const preview = pickMedia(file, ['xs', 'sm', 'md'], ['webp', 'gif']) ?? main;
    results.push({
      id: String(item.id ?? item.slug ?? main.url),
      title: typeof item.title === 'string' ? item.title : '',
      url: main.url,
      previewUrl: preview.url ?? main.url,
      width: main.width,
      height: main.height,
    });
  }
  const page = typeof data.current_page === 'number' ? data.current_page : 1;
  return { results, next: data.has_next ? String(page + 1) : null };
}

function parsePage(pos: unknown): number {
  const n = Number(pos);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 1;
}

export function gifRoutes(app: FastifyInstance, config: Config): void {
  // Stable-but-opaque per-user id for KLIPY analytics/monetization, derived from
  // the user id so we don't expose it directly.
  const customerId = (userId: string) =>
    createHash('sha256').update(`klipy:${userId}`).digest('hex').slice(0, 16);

  async function proxy(kind: 'search' | 'trending', page: number, customer: string, q?: string) {
    const params = new URLSearchParams({
      per_page: String(PER_PAGE),
      page: String(page),
      customer_id: customer,
    });
    if (q) params.set('q', q);
    const url = `${KLIPY_BASE}/${config.klipyApiKey}/gifs/${kind}?${params}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`klipy ${res.status}`);
    return normalize(await res.json());
  }

  app.get('/api/gifs/search', { preHandler: requireAuth }, async (request, reply) => {
    if (!config.klipyApiKey) return reply.code(503).send({ error: 'gif search disabled' });
    const { q, pos } = request.query as { q?: string; pos?: string };
    const query = (q ?? '').trim();
    if (!query) return reply.code(400).send({ error: 'missing query' });
    if (query.length > MAX_QUERY) return reply.code(400).send({ error: 'query too long' });
    try {
      return await proxy('search', parsePage(pos), customerId(request.user!.id), query);
    } catch (err) {
      request.log.warn({ err }, 'klipy search failed');
      return reply.code(502).send({ error: 'gif provider unavailable' });
    }
  });

  app.get('/api/gifs/trending', { preHandler: requireAuth }, async (request, reply) => {
    if (!config.klipyApiKey) return reply.code(503).send({ error: 'gif search disabled' });
    const { pos } = request.query as { pos?: string };
    try {
      return await proxy('trending', parsePage(pos), customerId(request.user!.id));
    } catch (err) {
      request.log.warn({ err }, 'klipy trending failed');
      return reply.code(502).send({ error: 'gif provider unavailable' });
    }
  });
}
