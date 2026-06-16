import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookie, makeApp, seedUser, type TestApp } from '../../test/helpers/server.js';

// A public IP literal as the host avoids DNS in assertPublicHost — the fetch is
// stubbed, so no real request is made.
const PUBLIC = 'http://93.184.216.34/page';

function htmlResponse(html: string, contentType = 'text/html; charset=utf-8') {
  return new Response(html, { status: 200, headers: { 'content-type': contentType } });
}

let t: TestApp;
let cookie: string;

function inject(url: string, c = cookie) {
  return t.app.inject({ method: 'GET', url, headers: c ? { cookie: c } : {} });
}

beforeEach(async () => {
  t = await makeApp();
  cookie = authCookie(t.db, seedUser(t.db));
});
afterEach(() => {
  vi.unstubAllGlobals();
  return t.cleanup();
});

const og = (u: string) => `/api/og?url=${encodeURIComponent(u)}`;

describe('GET /api/og — SSRF-guarded link-preview proxy', () => {
  it('requires auth', async () => {
    expect((await inject(og(PUBLIC), '')).statusCode).toBe(401);
  });

  it('rejects a non-http(s) scheme', async () => {
    expect((await inject(og('ftp://example.com'))).statusCode).toBe(400);
    expect((await inject(og('file:///etc/passwd'))).statusCode).toBe(400);
  });

  it('rejects a malformed url', async () => {
    expect((await inject(og('not a url'))).statusCode).toBe(400);
  });

  it('blocks loopback / private / cloud-metadata hosts (SSRF)', async () => {
    const fetchMock = vi.fn(async () => htmlResponse('<title>x</title>'));
    vi.stubGlobal('fetch', fetchMock);
    for (const u of [
      'http://127.0.0.1/',
      'http://localhost/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://192.168.1.1/',
      'http://[::1]/',
    ]) {
      expect((await inject(og(u))).statusCode).toBe(502);
    }
    // Never even attempted the request for a blocked host.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses Open Graph tags from a public host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        htmlResponse(`<html><head>
          <meta property="og:title" content="Hello &amp; World">
          <meta property="og:description" content="A nice page">
          <meta property="og:image" content="/img/cover.png">
          <meta property="og:site_name" content="Example">
          <title>fallback</title>
        </head></html>`),
      ),
    );
    const res = await inject(og(PUBLIC));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      title: 'Hello & World',
      description: 'A nice page',
      siteName: 'Example',
      image: 'http://93.184.216.34/img/cover.png', // resolved against the page
    });
  });

  it('blocks a redirect to a private address (re-validates each hop)', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await inject(og(PUBLIC))).statusCode).toBe(502);
    // The public origin was fetched once; the private redirect target was
    // rejected before any second request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('502s on a non-HTML response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('not html', 'text/plain')));
    expect((await inject(og(PUBLIC))).statusCode).toBe(502);
  });

  it('404s when there is no usable preview content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<html><head></head><body>hi</body></html>')));
    expect((await inject(og(PUBLIC))).statusCode).toBe(404);
  });
});

describe('PUT /api/profile/link-previews', () => {
  it('toggles the setting (default off) and surfaces it on ProfileInfo', async () => {
    const me = seedUser(t.db);
    const c = authCookie(t.db, me);
    expect((await t.app.inject({ method: 'GET', url: '/api/profile', headers: { cookie: c } })).json().linkPreviews).toBe(false);
    const res = await t.app.inject({ method: 'PUT', url: '/api/profile/link-previews', headers: { cookie: c }, payload: { enabled: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().linkPreviews).toBe(true);
  });

  it('rejects a non-boolean', async () => {
    const c = authCookie(t.db, seedUser(t.db));
    const res = await t.app.inject({ method: 'PUT', url: '/api/profile/link-previews', headers: { cookie: c }, payload: { enabled: 'yes' } });
    expect(res.statusCode).toBe(400);
  });
});
