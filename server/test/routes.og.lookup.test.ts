import type { LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { publicOnlyLookup } from '../src/routes/og.js';

// The connect-time DNS guard that closes the rebinding TOCTOU: every outbound
// link-preview connection resolves through this, so an IP that turns out to be
// private is rejected at the socket layer, not just at the pre-check.
// Literal IPs and `localhost` resolve locally, so these need no network.
function resolve(host: string, all: boolean): Promise<{ addr: string | LookupAddress[]; family?: number }> {
  return new Promise((res, rej) => {
    publicOnlyLookup(host, { all }, (err, addr, family) => (err ? rej(err) : res({ addr, family })));
  });
}

describe('publicOnlyLookup (link-preview SSRF connect guard)', () => {
  it('rejects a host resolving to a loopback / private address', async () => {
    await expect(resolve('127.0.0.1', true)).rejects.toThrow('blocked address');
    await expect(resolve('169.254.169.254', true)).rejects.toThrow('blocked address');
    await expect(resolve('localhost', true)).rejects.toThrow('blocked address');
  });

  it('returns the full address list (undici asks with all:true)', async () => {
    const { addr } = await resolve('8.8.8.8', true);
    expect(addr).toEqual([{ address: '8.8.8.8', family: 4 }]);
  });

  it('returns a single address + family when all is false', async () => {
    const { addr, family } = await resolve('8.8.8.8', false);
    expect(addr).toBe('8.8.8.8');
    expect(family).toBe(4);
  });
});
