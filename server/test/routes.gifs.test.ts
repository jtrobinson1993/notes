import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authCookie, makeApp, seedUser, type TestApp } from '../../test/helpers/server.js';

// A trimmed KLIPY response: one usable item (md.webp + xs.webp) and one junk
// item with no usable media (must be dropped by normalize()).
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
      { id: 7, title: 'broken', file: { md: {} } },
    ],
  },
};

let t: TestApp;
let cookie: string;

function inject(url: string, c = cookie) {
  return t.app.inject({ method: 'GET', url, headers: c ? { cookie: c } : {} });
}

afterEach(() => {
  vi.unstubAllGlobals();
  return t.cleanup();
});

describe('GET /api/gifs/* — KLIPY proxy (key configured)', () => {
  beforeEach(async () => {
    t = await makeApp({ klipyApiKey: 'test-key' });
    cookie = authCookie(t.db, seedUser(t.db));
  });

  it('requires auth', async () => {
    const res = await inject('/api/gifs/search?q=cat', '');
    expect(res.statusCode).toBe(401);
  });

  it('rejects an empty query', async () => {
    const res = await inject('/api/gifs/search?q=%20%20');
    expect(res.statusCode).toBe(400);
  });

  it('rejects an over-long query', async () => {
    const res = await inject(`/api/gifs/search?q=${'x'.repeat(101)}`);
    expect(res.statusCode).toBe(400);
  });

  it('normalizes results and keeps the API key server-side', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(KLIPY_OK), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await inject('/api/gifs/search?q=cat');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The junk item with no usable media is dropped.
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      id: '42',
      title: 'Happy Cat',
      url: 'https://static.klipy.com/md.webp',
      previewUrl: 'https://static.klipy.com/xs.webp',
      width: 220,
      height: 180,
    });
    expect(body.next).toBe('2'); // has_next -> current_page + 1

    // The upstream URL embeds the key + query; the client never sees the key.
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/test-key/gifs/search');
    expect(calledUrl).toContain('q=cat');
    expect(res.payload).not.toContain('test-key');
  });

  it('maps upstream failure to 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    const res = await inject('/api/gifs/search?q=cat');
    expect(res.statusCode).toBe(502);
  });

  it('serves trending without a query', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(KLIPY_OK), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await inject('/api/gifs/trending');
    expect(res.statusCode).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/gifs/trending');
  });
});

describe('GET /api/gifs/* — no key configured', () => {
  beforeEach(async () => {
    t = await makeApp(); // klipyApiKey defaults to null
    cookie = authCookie(t.db, seedUser(t.db));
  });

  it('returns 503 for search', async () => {
    const res = await inject('/api/gifs/search?q=cat');
    expect(res.statusCode).toBe(503);
  });

  it('returns 503 for trending', async () => {
    const res = await inject('/api/gifs/trending');
    expect(res.statusCode).toBe(503);
  });
});
