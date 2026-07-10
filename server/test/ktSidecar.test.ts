import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKtSidecar } from '../src/ktSidecar.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const { status = 200, body } = handler(String(url), init);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe('createKtSidecar client', () => {
  it('maps a 404 lookup to null (unknown handle)', async () => {
    mockFetch(() => ({ status: 404, body: {} }));
    const kt = createKtSidecar('http://sc', 'tok');
    expect(await kt.lookup('Ghost#0000')).toBeNull();
  });

  it('caches the VRF public key (fetched once)', async () => {
    const spy = mockFetch(() => ({ body: { key: 'VRFKEY' } }));
    const kt = createKtSidecar('http://sc', 'tok');
    expect(await kt.vrfPublicKey()).toBe('VRFKEY');
    expect(await kt.vrfPublicKey()).toBe('VRFKEY');
    expect(spy).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it('sends the bearer token and trims a trailing slash from the base url', async () => {
    const spy = mockFetch(() => ({ body: { epoch: 1, root: 'R' } }));
    const kt = createKtSidecar('http://sc/', 'tok');
    await kt.publish([{ handle: 'A#1', key: 'K' }]);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('http://sc/publish'); // single slash
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });
});
