// Server-side proxy for KLIPY GIF search. Two properties matter and both are
// the reason this exists at all:
//   1. the API key stays on the server (never shipped to a client), and
//   2. the CLIENT'S IP never reaches KLIPY — the relay makes the request.
// The chosen GIF's CDN URL is what the client embeds inside the encrypted
// message. See spec/chat.md + spec/security.md.

import { createHash } from 'node:crypto';
import type { GifSearchResult, GifSearchResponse } from '@notes/shared';

const KLIPY_BASE = 'https://api.klipy.com/api/v1';
const PER_PAGE = 24;
export const MAX_GIF_QUERY = 100;

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

export function normalizeGifs(raw: unknown): GifSearchResponse {
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

export function parseGifPage(pos: unknown): number {
  const n = Number(pos);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 1;
}

/** Stable-but-opaque per-user id for KLIPY analytics/monetization, derived from
 *  the account id so we never hand the provider our real identifier. */
export function klipyCustomerId(userId: string): string {
  return createHash('sha256').update(`klipy:${userId}`).digest('hex').slice(0, 16);
}

export async function klipyProxy(
  apiKey: string,
  kind: 'search' | 'trending',
  page: number,
  customer: string,
  q?: string,
): Promise<GifSearchResponse> {
  const params = new URLSearchParams({
    per_page: String(PER_PAGE),
    page: String(page),
    customer_id: customer,
  });
  if (q) params.set('q', q);
  const url = `${KLIPY_BASE}/${apiKey}/gifs/${kind}?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  // Never let the key or the query reach a log line via an error message.
  if (!res.ok) throw new Error(`klipy ${kind} ${res.status}`);
  return normalizeGifs(await res.json());
}
