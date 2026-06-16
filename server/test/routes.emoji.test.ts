import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookie, makeApp, seedUser, type TestApp } from '../../test/helpers/server.js';

// A valid 7TV ULID (Crockford base32, 26 chars) and a tiny fake WebP body.
const ID = '01F6MKTFTG0009C9ZSNZTFV2ZF';
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

function webpResponse() {
  return new Response(WEBP, { status: 200, headers: { 'content-type': 'image/webp' } });
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

describe('GET /emoji/7tv/:file — 7TV image proxy + cache', () => {
  it('requires auth', async () => {
    const res = await inject(`/emoji/7tv/${ID}.webp`, '');
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-ULID emote id (no open proxy)', async () => {
    const fetchMock = vi.fn(webpResponse);
    vi.stubGlobal('fetch', fetchMock);
    const res = await inject('/emoji/7tv/..%2f..%2fetc%2fpasswd.webp');
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches from the 7TV CDN, caches, and serves on subsequent hits', async () => {
    const fetchMock = vi.fn(webpResponse);
    vi.stubGlobal('fetch', fetchMock);

    const first = await inject(`/emoji/7tv/${ID}.webp`);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('image/webp');
    expect(first.headers['cache-control']).toContain('immutable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![0] as string)).toBe(`https://cdn.7tv.app/emote/${ID}/2x.webp`);

    // Second request is served from disk cache — no second upstream fetch.
    const second = await inject(`/emoji/7tv/${ID}.webp`);
    expect(second.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('502s when the upstream fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })));
    const res = await inject(`/emoji/7tv/${ID}.webp`);
    expect(res.statusCode).toBe(502);
  });

  it('502s when the upstream returns a non-image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    );
    const res = await inject(`/emoji/7tv/${ID}.webp`);
    expect(res.statusCode).toBe(502);
  });
});
