import dns from 'node:dns/promises';
import net from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { LinkPreview } from '@notes/shared';
import { requireAuth } from '../session.js';

// Server-side Open Graph proxy for link previews. The browser can't fetch
// arbitrary cross-origin pages, so the sender's client asks the server to fetch
// the URL and return its OG metadata, which it then embeds (encrypted) in the
// message. Because the SERVER makes an outbound request to a user-supplied URL,
// this is an SSRF surface and is guarded accordingly: http(s) only, the host
// must resolve to a public IP, redirects are followed manually and re-validated
// each hop, and the response is size- and time-capped.

const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 4;
const MAX_FIELD = 500;

function isPrivateIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === '::1' || x === '::') return true; // loopback / unspecified
  if (/^f[cd]/.test(x)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(x)) return true; // fe80::/10 link-local
  if (x.startsWith('ff')) return true; // multicast
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x); // IPv4-mapped
  if (mapped) return isPrivateIpv4(mapped[1]!);
  return false;
}

function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIpv4(ip);
  if (v === 6) return isPrivateIpv6(ip);
  return true; // not a literal IP → caller must resolve first
}

/** Throw unless every resolved address for the host is a public, routable IP.
 *  (Residual DNS-rebinding risk between this check and the fetch is accepted for
 *  a small self-hosted deployment.) */
async function assertPublicHost(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('blocked address');
    return;
  }
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    throw new Error('blocked host');
  }
  const records = await dns.lookup(hostname, { all: true });
  if (!records.length) throw new Error('no address');
  for (const r of records) if (isPrivateIp(r.address)) throw new Error('blocked address');
}

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
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
    await assertPublicHost(u.hostname);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'NotesLinkPreview/1.0 (+link-preview)', accept: 'text/html,application/xhtml+xml' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('redirect without location');
      url = new URL(loc, url).toString(); // re-validated at the top of the loop
      continue;
    }
    if (!res.ok) throw new Error(`status ${res.status}`);
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) throw new Error('not html');
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

function buildPreview(html: string, finalUrl: string): LinkPreview {
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

export function ogRoutes(app: FastifyInstance): void {
  app.get('/api/og', { preHandler: requireAuth }, async (request, reply) => {
    const url = (request.query as { url?: string })?.url;
    if (typeof url !== 'string' || url.length > 2048) return reply.code(400).send({ error: 'invalid url' });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reply.code(400).send({ error: 'invalid url' });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return reply.code(400).send({ error: 'unsupported scheme' });
    }
    let result: { html: string; finalUrl: string };
    try {
      result = await fetchHtml(url);
    } catch {
      return reply.code(502).send({ error: 'could not fetch preview' });
    }
    const preview = buildPreview(result.html, result.finalUrl);
    // Nothing worth showing → let the client skip the card.
    if (!preview.title && !preview.image && !preview.description) {
      return reply.code(404).send({ error: 'no preview' });
    }
    return preview;
  });
}
