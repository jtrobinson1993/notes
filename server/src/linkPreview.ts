// Server-side Open Graph fetch + parse for link previews. The client can't
// fetch arbitrary cross-origin pages, and — more importantly — we don't want the
// SENDER'S IP to reach the link target, so the relay fetches the URL and returns
// its OG metadata, which the client then embeds (encrypted) in the message.
//
// Because the SERVER makes an outbound request to a user-supplied URL this is an
// SSRF surface, guarded by ssrf.ts: http(s) only, the host must resolve to a
// public IP (pre-check AND connect-time re-validation), redirects are followed
// manually and re-validated each hop, and the response is size- and time-capped
// (per hop and across the whole redirect chain).

import type { LinkPreview } from '@notes/shared';
import { assertPublicHost, ssrfSafeAgent } from './ssrf.js';

export const OG_MAX_URL = 2048;
const HOP_TIMEOUT_MS = 6000;
const TOTAL_TIMEOUT_MS = 10_000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 4;
const MAX_FIELD = 500;

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
      if (total >= max) {
        await reader.cancel();
        break;
      }
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchHtml(initialUrl: string): Promise<{ html: string; finalUrl: string }> {
  let url = initialUrl;
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    await assertPublicHost(u.hostname);
    // Budget the whole chain, not just each hop, so N redirects can't stretch
    // one request into N × the per-hop timeout.
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('timeout');
    const init: RequestInit = {
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.min(HOP_TIMEOUT_MS, remaining)),
      headers: {
        'user-agent': 'AccordLinkPreview/1.0 (+link-preview)',
        accept: 'text/html,application/xhtml+xml',
      },
    };
    // Node's fetch honors an undici dispatcher even though the DOM RequestInit
    // type omits it; this is what routes the request through publicOnlyLookup.
    (init as RequestInit & { dispatcher: typeof ssrfSafeAgent }).dispatcher = ssrfSafeAgent;
    const res = await fetch(url, init);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('redirect without location');
      url = new URL(loc, url).toString(); // re-validated at the top of the loop
      if (url.length > OG_MAX_URL) throw new Error('redirect url too long');
      continue;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) throw new Error('not html');
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error('too large');
    return { html: await readCapped(res, MAX_BYTES), finalUrl: url };
  }
  throw new Error('too many redirects');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function fromCodePoint(code: number): string | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return undefined;
  try {
    return String.fromCodePoint(code);
  } catch {
    return undefined;
  }
}

// Single-pass HTML-entity decode. Each entity is resolved exactly once and the
// output is never re-scanned, so a payload like `&amp;lt;` decodes to the literal
// `&lt;` rather than double-unescaping to `<` (CodeQL js/double-escaping).
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return fromCodePoint(code) ?? match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function clamp(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = decodeEntities(s).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, MAX_FIELD) : undefined;
}

// `<meta property|name="key" content="...">` in either attribute order.
function metaContent(html: string, key: string): string | undefined {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*?content=["']([^"']*)["']`, 'i').exec(html);
  if (a) return a[1];
  const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["']${k}["']`, 'i').exec(html);
  return b ? b[1] : undefined;
}

export function buildPreview(html: string, finalUrl: string): LinkPreview {
  const head = html.slice(0, 64 * 1024); // OG tags live in <head>
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1];
  const preview: LinkPreview = {
    url: finalUrl,
    title: clamp(metaContent(head, 'og:title') ?? titleTag),
    description: clamp(metaContent(head, 'og:description') ?? metaContent(head, 'description')),
    siteName: clamp(metaContent(head, 'og:site_name')),
  };
  const img = metaContent(head, 'og:image') ?? metaContent(head, 'og:image:url');
  if (img) {
    try {
      const abs = new URL(decodeEntities(img).trim(), finalUrl);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') preview.image = abs.toString();
    } catch {
      /* ignore a malformed image URL */
    }
  }
  return preview;
}

export type LinkPreviewOutcome =
  | { ok: true; preview: LinkPreview }
  | { ok: false; reason: 'invalid-url' | 'unsupported-scheme' | 'fetch-failed' | 'no-preview' };

/** Validate + fetch + parse a user-supplied URL into a LinkPreview. Never
 *  throws; the caller maps the reason onto a status code. */
export async function fetchLinkPreview(url: unknown): Promise<LinkPreviewOutcome> {
  if (typeof url !== 'string' || url.length === 0 || url.length > OG_MAX_URL) {
    return { ok: false, reason: 'invalid-url' };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported-scheme' };
  }
  let result: { html: string; finalUrl: string };
  try {
    result = await fetchHtml(url);
  } catch {
    return { ok: false, reason: 'fetch-failed' };
  }
  const preview = buildPreview(result.html, result.finalUrl);
  // Nothing worth showing → let the client skip the card.
  if (!preview.title && !preview.image && !preview.description) {
    return { ok: false, reason: 'no-preview' };
  }
  return { ok: true, preview };
}
