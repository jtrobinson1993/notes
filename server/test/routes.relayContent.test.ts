import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrollDevice, makeRelayApp, type TestApp } from '../../test/helpers/server.js';

// The three relay content proxies (routes/relayContent.ts). Their whole reason
// to exist is that the CLIENT'S IP must never reach Klipy / 7TV / a link target,
// so every test here asserts the relay is the one making the outbound call and
// that the guard in front of it holds.

let ctx: TestApp | null = null;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (ctx) await ctx.cleanup();
  ctx = null;
});

async function relay(overrides = {}): Promise<{ t: TestApp; bearer: string; userId: string }> {
  const t = await makeRelayApp(overrides);
  ctx = t;
  const { bearer, userId } = await enrollDevice(t.app, t.db);
  return { t, bearer, userId };
}

const auth = (bearer: string) => ({ authorization: bearer });

// ---------------------------------------------------------------- GIF search

const KLIPY_OK = {
  result: true,
  data: {
    current_page: 1,
    per_page: 24,
    has_next: true,
    data: [
      {
        id: 42,
        slug: 'happy-cat',
        title: 'Happy Cat',
        file: {
          md: { webp: { url: 'https://static.klipy.com/md.webp', width: 220, height: 180 } },
          xs: { webp: { url: 'https://static.klipy.com/xs.webp', width: 80, height: 65 } },
        },
      },
      { id: 7, title: 'broken', file: { md: {} } }, // no usable media → dropped
    ],
  },
};

describe('GET /api/relay/gifs/* — device-authed Klipy proxy', () => {
  it('requires a device token', async () => {
    const { t } = await relay({ klipyApiKey: 'test-key' });
    const res = await t.app.inject({ method: 'GET', url: '/api/relay/gifs/search?q=cat' });
    expect(res.statusCode).toBe(401);
    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/relay/gifs/trending',
      headers: { authorization: 'Bearer v1.nope.9999999999.zzzz' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('normalizes results and never leaks the API key to the client', async () => {
    const { t, bearer } = await relay({ klipyApiKey: 'test-key' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(KLIPY_OK), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/relay/gifs/search?q=cat',
      headers: auth(bearer),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      id: '42',
      url: 'https://static.klipy.com/md.webp',
      previewUrl: 'https://static.klipy.com/xs.webp',
      width: 220,
      height: 180,
    });
    expect(body.next).toBe('2');

    // The relay — not the client — talked to Klipy, with the key in the URL.
    const called = String(fetchMock.mock.calls[0]![0]);
    expect(called).toContain('/test-key/gifs/search');
    expect(called).toContain('q=cat');
    expect(res.payload).not.toContain('test-key');
  });

  it('derives a stable pseudonymous customer_id from the account (not the real id)', async () => {
    const { t, bearer, userId } = await relay({ klipyApiKey: 'test-key' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(KLIPY_OK), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await t.app.inject({ method: 'GET', url: '/api/relay/gifs/trending', headers: auth(bearer) });
    await t.app.inject({ method: 'GET', url: '/api/relay/gifs/trending', headers: auth(bearer) });
    const first = new URL(String(fetchMock.mock.calls[0]![0])).searchParams.get('customer_id');
    const second = new URL(String(fetchMock.mock.calls[1]![0])).searchParams.get('customer_id');
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(first).toBe(second);
    expect(first).not.toContain(userId);
  });

  it('validates the query and maps upstream failure to 502', async () => {
    const { t, bearer } = await relay({ klipyApiKey: 'test-key' });
    const empty = await t.app.inject({
      method: 'GET',
      url: '/api/relay/gifs/search?q=%20%20',
      headers: auth(bearer),
    });
    expect(empty.statusCode).toBe(400);
    const long = await t.app.inject({
      method: 'GET',
      url: `/api/relay/gifs/search?q=${'x'.repeat(101)}`,
      headers: auth(bearer),
    });
    expect(long.statusCode).toBe(400);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const boom = await t.app.inject({
      method: 'GET',
      url: '/api/relay/gifs/search?q=cat',
      headers: auth(bearer),
    });
    expect(boom.statusCode).toBe(502);
  });

  it('503s when the operator configured no Klipy key', async () => {
    const { t, bearer } = await relay(); // klipyApiKey null
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/relay/gifs/search?q=cat',
      headers: auth(bearer),
    });
    expect(res.statusCode).toBe(503);
  });

  it('has its own rate-limit bucket (tighter than the global ceiling)', async () => {
    // gif bucket = ceil(rateLimitMax / 10) = 2
    const { t, bearer } = await relay({ klipyApiKey: 'test-key', rateLimitMax: 20 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(KLIPY_OK), { status: 200 })));
    for (let i = 0; i < 2; i++) {
      const ok = await t.app.inject({
        method: 'GET',
        url: '/api/relay/gifs/search?q=cat',
        headers: auth(bearer),
      });
      expect(ok.statusCode).toBe(200);
    }
    const blocked = await t.app.inject({
      method: 'GET',
      url: '/api/relay/gifs/search?q=cat',
      headers: auth(bearer),
    });
    expect(blocked.statusCode).toBe(429);
  });
});

// ------------------------------------------------------------- link previews

const PUBLIC = 'http://93.184.216.34/page'; // literal public IP → no DNS needed
const OG_HTML =
  '<html><head><title>Fallback</title>' +
  '<meta property="og:title" content="Real Title">' +
  '<meta property="og:description" content="A description">' +
  '<meta property="og:image" content="/img/hero.png">' +
  '</head><body>x</body></html>';

const ogUrl = (u: string) => `/api/relay/og?url=${encodeURIComponent(u)}`;

function htmlResponse(html: string) {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

describe('GET /api/relay/og — device-authed, SSRF-guarded link preview', () => {
  it('requires a device token (an open OG proxy is SSRF-as-a-service)', async () => {
    const { t } = await relay();
    const fetchMock = vi.fn(async () => htmlResponse(OG_HTML));
    vi.stubGlobal('fetch', fetchMock);
    const res = await t.app.inject({ method: 'GET', url: ogUrl(PUBLIC) });
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled(); // no outbound request for a stranger
  });

  it('rejects non-http(s) schemes and malformed urls', async () => {
    const { t, bearer } = await relay();
    for (const u of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect((await t.app.inject({ method: 'GET', url: ogUrl(u), headers: auth(bearer) })).statusCode).toBe(400);
    }
    expect((await t.app.inject({ method: 'GET', url: '/api/relay/og?url=not-a-url', headers: auth(bearer) })).statusCode).toBe(400);
    const over = await t.app.inject({
      method: 'GET',
      url: ogUrl(`http://93.184.216.34/${'a'.repeat(2100)}`),
      headers: auth(bearer),
    });
    expect(over.statusCode).toBe(400);
  });

  it('refuses private / loopback / metadata / .internal targets (SSRF)', async () => {
    const { t, bearer } = await relay();
    const fetchMock = vi.fn(async () => htmlResponse(OG_HTML));
    vi.stubGlobal('fetch', fetchMock);
    const targets = [
      'http://127.0.0.1/admin',
      'http://localhost:3000/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://box.local/',
      'http://[64:ff9b::7f00:1]/', // NAT64-embedded 127.0.0.1
      'http://[2002:7f00:1::]/', // 6to4-embedded 127.0.0.1
    ];
    for (const u of targets) {
      const res = await t.app.inject({ method: 'GET', url: ogUrl(u), headers: auth(bearer) });
      expect(res.statusCode, u).toBe(502);
    }
    expect(fetchMock).not.toHaveBeenCalled(); // blocked before any outbound request
  });

  it('re-validates each redirect hop and refuses one that lands on a private host', async () => {
    const { t, bearer } = await relay();
    const fetchMock = vi.fn(
      async () =>
        new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await t.app.inject({ method: 'GET', url: ogUrl(PUBLIC), headers: auth(bearer) });
    expect(res.statusCode).toBe(502);
    // The first hop happened; the redirect target was rejected before hop two.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the parsed preview with an absolute image url', async () => {
    const { t, bearer } = await relay();
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(OG_HTML)));
    const res = await t.app.inject({ method: 'GET', url: ogUrl(PUBLIC), headers: auth(bearer) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      url: PUBLIC,
      title: 'Real Title',
      description: 'A description',
      image: 'http://93.184.216.34/img/hero.png',
    });
  });

  it('decodes entities in a single pass (no double-unescaping)', async () => {
    const { t, bearer } = await relay();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        htmlResponse(`<html><head>
          <meta property="og:title" content="Tom &amp; Jerry &lt;3 &#39;quotes&#39;">
          <meta property="og:description" content="&amp;lt;script&amp;gt; stays inert">
        </head></html>`),
      ),
    );
    const res = await t.app.inject({ method: 'GET', url: ogUrl(PUBLIC), headers: auth(bearer) });
    expect(res.statusCode).toBe(200);
    // `&amp;` → `&`, `&lt;` → `<`, `&#39;` → `'` — each decoded once.
    expect(res.json().title).toBe(`Tom & Jerry <3 'quotes'`);
    // `&amp;lt;` must decode to the literal `&lt;`, NOT collapse to `<`.
    expect(res.json().description).toBe('&lt;script&gt; stays inert');
  });

  it('404s when the page has nothing worth previewing, 502 on a non-html body', async () => {
    const { t, bearer } = await relay();
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<html><head></head><body>hi</body></html>')));
    expect((await t.app.inject({ method: 'GET', url: ogUrl(PUBLIC), headers: auth(bearer) })).statusCode).toBe(404);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    expect((await t.app.inject({ method: 'GET', url: ogUrl(PUBLIC), headers: auth(bearer) })).statusCode).toBe(502);
  });

  it('has its own (tightest) rate-limit bucket', async () => {
    // og bucket = ceil(rateLimitMax / 20) = 1
    const { t, bearer } = await relay({ rateLimitMax: 20 });
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(OG_HTML)));
    expect((await t.app.inject({ method: 'GET', url: ogUrl(PUBLIC), headers: auth(bearer) })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: ogUrl(PUBLIC), headers: auth(bearer) })).statusCode).toBe(429);
  });
});

// -------------------------------------------------------------- 7TV emotes

const ID_A = '01F6MKTFTG0009C9ZSNZTFV2ZF';
const ID_B = '01F6MKTFTG0009C9ZSNZTFV2ZG';
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function gqlBody(ids: string[]) {
  return JSON.stringify({
    data: {
      emotes: {
        items: ids.map((id, i) => ({
          id,
          name: `Emote${i}`,
          animated: i === 0,
          host: { files: [{ name: '2x.webp', format: 'WEBP', width: 64, height: 64 }] },
        })),
      },
    },
  });
}

/** A fetch stub that answers 7TV's GraphQL and CDN separately. */
function stub7tv(ids: string[]) {
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith('https://7tv.io/v3/gql')) {
      return new Response(gqlBody(ids), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.startsWith('https://cdn.7tv.app/emote/')) {
      return new Response(WEBP, { status: 200, headers: { 'content-type': 'image/webp' } });
    }
    throw new Error(`unexpected upstream ${url}`);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

async function searchEmotes(t: TestApp, bearer: string, q = 'cat') {
  return t.app.inject({
    method: 'GET',
    url: `/api/relay/emotes/search?q=${encodeURIComponent(q)}`,
    headers: auth(bearer),
  });
}

describe('GET /api/relay/emotes/search — device-authed 7TV search proxy', () => {
  it('requires a device token', async () => {
    const { t } = await relay();
    const mock = stub7tv([ID_A]);
    const res = await t.app.inject({ method: 'GET', url: '/api/relay/emotes/search?q=cat' });
    expect(res.statusCode).toBe(401);
    expect(mock).not.toHaveBeenCalled();
  });

  it('proxies 7TV and mints a capability image url per emote', async () => {
    const { t, bearer } = await relay();
    const mock = stub7tv([ID_A, ID_B]);
    const res = await searchEmotes(t, bearer);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ id: ID_A, name: 'Emote0', width: 64, height: 64, animated: true });
    expect(body.results[0].url).toMatch(new RegExp(`^/api/relay/emote/[A-Za-z0-9_-]{22}/${ID_A}\\.webp$`));
    // Short page → no next cursor.
    expect(body.next).toBeNull();
    // The relay is the one that talked to 7TV.
    expect(String(mock.mock.calls[0]![0])).toBe('https://7tv.io/v3/gql');
  });

  it('drops malformed items and rejects an over-long query', async () => {
    const { t, bearer } = await relay();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                emotes: {
                  items: [
                    { id: 'not-a-ulid', name: 'Bad', host: { files: [{ name: '2x.webp', width: 1, height: 1 }] } },
                    { id: ID_A, name: 'has spaces', host: { files: [{ name: '2x.webp', width: 1, height: 1 }] } },
                    { id: ID_B, name: 'NoFiles', host: { files: [] } },
                  ],
                },
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const res = await searchEmotes(t, bearer);
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toHaveLength(0);

    const long = await searchEmotes(t, bearer, 'x'.repeat(101));
    expect(long.statusCode).toBe(400);
  });

  it('maps an upstream failure to 502', async () => {
    const { t, bearer } = await relay();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect((await searchEmotes(t, bearer)).statusCode).toBe(502);
  });
});

describe('GET /api/relay/emote/:sig/:file — capability-gated image proxy + cache', () => {
  it('serves via the minted capability, caching after the first upstream fetch', async () => {
    const { t, bearer } = await relay();
    const mock = stub7tv([ID_A]);
    const url = (await searchEmotes(t, bearer)).json().results[0].url as string;
    const upstreamCalls = () =>
      mock.mock.calls.filter((c) => String(c[0]).startsWith('https://cdn.7tv.app/')).length;

    // No Authorization header at all — this must work as a plain <img src>.
    const first = await t.app.inject({ method: 'GET', url });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('image/webp');
    expect(first.headers['cache-control']).toContain('immutable');
    expect(first.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(upstreamCalls()).toBe(1);
    expect(String(mock.mock.calls.at(-1)![0])).toBe(`https://cdn.7tv.app/emote/${ID_A}/2x.webp`);

    // Second hit is served from the disk cache — no second upstream fetch.
    const second = await t.app.inject({ method: 'GET', url });
    expect(second.statusCode).toBe(200);
    expect(second.rawPayload.equals(Buffer.from(WEBP))).toBe(true);
    expect(upstreamCalls()).toBe(1);
  });

  it('refuses a forged or missing capability (403) — no relay-as-7TV-mirror', async () => {
    const { t } = await relay();
    const mock = stub7tv([ID_A]);
    const forged = await t.app.inject({ method: 'GET', url: `/api/relay/emote/${'a'.repeat(22)}/${ID_A}.webp` });
    expect(forged.statusCode).toBe(403);
    const short = await t.app.inject({ method: 'GET', url: `/api/relay/emote/x/${ID_A}.webp` });
    expect(short.statusCode).toBe(403);
    expect(mock.mock.calls.filter((c) => String(c[0]).startsWith('https://cdn.7tv.app/'))).toHaveLength(0);
  });

  it('accepts a device bearer instead of the capability', async () => {
    const { t, bearer } = await relay();
    stub7tv([ID_A]);
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/relay/emote/${'a'.repeat(22)}/${ID_A}.webp`,
      headers: auth(bearer),
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a non-ULID id / traversal attempt before any credential check', async () => {
    const { t, bearer } = await relay();
    const mock = stub7tv([ID_A]);
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/relay/emote/${'a'.repeat(22)}/..%2f..%2fetc%2fpasswd.webp`,
      headers: auth(bearer),
    });
    expect(res.statusCode).toBe(400);
    expect(mock).not.toHaveBeenCalled();
  });

  it('502s an upstream miss / non-image / oversized body', async () => {
    const { t, bearer } = await relay();
    const url = `/api/relay/emote/${'a'.repeat(22)}/${ID_A}.webp`;

    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })));
    expect((await t.app.inject({ method: 'GET', url, headers: auth(bearer) })).statusCode).toBe(502);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    expect((await t.app.inject({ method: 'GET', url, headers: auth(bearer) })).statusCode).toBe(502);

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(1024 * 1024 + 1), {
            status: 200,
            headers: { 'content-type': 'image/webp' },
          }),
      ),
    );
    expect((await t.app.inject({ method: 'GET', url, headers: auth(bearer) })).statusCode).toBe(502);
  });

  it('capability urls survive a relay restart (derived from the pinned identity)', async () => {
    const t = await makeRelayApp();
    ctx = t;
    const { bearer } = await enrollDevice(t.app, t.db);
    stub7tv([ID_A]);
    const url = (await searchEmotes(t, bearer)).json().results[0].url as string;
    await t.app.close();

    // Rebuild the app over the SAME database/data dir.
    const { buildRelayApp } = await import('../src/relay-app.js');
    const app2 = await buildRelayApp(t.db, t.config);
    app2.log.level = 'silent';
    await app2.ready();
    try {
      expect((await app2.inject({ method: 'GET', url })).statusCode).toBe(200);
    } finally {
      await app2.close();
    }
    // cleanup() would close an already-closed app; only the db/dir remain.
    ctx = { ...t, cleanup: async () => t.db.raw.close() };
  });
});
