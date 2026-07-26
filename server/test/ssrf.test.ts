import { describe, expect, it } from 'vitest';
import { assertPublicHost, isPrivateIp } from '../src/ssrf.js';

// The address classifier behind the link-preview proxy's SSRF guard. Anything
// that can reach an internal host must be rejected here, including the IPv6
// transition formats that smuggle an IPv4 address inside a v6 one.

describe('isPrivateIp', () => {
  it('rejects the IPv4 ranges that reach internal infrastructure', () => {
    for (const ip of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254', // cloud metadata
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1', // CGNAT
      '192.0.0.1',
      '192.0.2.5', // TEST-NET-1
      '198.18.0.1', // benchmarking
      '198.51.100.7', // TEST-NET-2
      '203.0.113.9', // TEST-NET-3
      '224.0.0.1', // multicast
      '255.255.255.255',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('allows ordinary public IPv4', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.32.0.1', '198.20.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('rejects private IPv6, including IPv4 smuggled through transition formats', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1', // IPv4-mapped
      '::ffff:7f00:1', // same, hex form
      '::127.0.0.1', // deprecated IPv4-compatible
      '64:ff9b::7f00:1', // NAT64 well-known prefix → 127.0.0.1
      '64:ff9b::169.254.169.254', // NAT64 → cloud metadata
      '2002:7f00:1::', // 6to4 → 127.0.0.1
      '2002:a00:1::', // 6to4 → 10.0.0.1
      'fe80::1%eth0', // zone id must not defeat the check
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv6, including transition formats wrapping a public IPv4', () => {
    for (const ip of ['2001:4860:4860::8888', '2606:4700::1111', '64:ff9b::8.8.8.8', '2002:808:808::']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('treats a non-literal (a hostname) as unsafe — the caller must resolve first', () => {
    expect(isPrivateIp('example.com')).toBe(true);
    expect(isPrivateIp('')).toBe(true);
  });
});

describe('assertPublicHost', () => {
  it('blocks internal-only suffixes without touching DNS', async () => {
    for (const host of [
      'localhost',
      'app.localhost',
      'printer.local',
      'metadata.google.internal',
      'router.home.arpa',
      '1.0.0.127.in-addr.arpa',
      'localhost.', // trailing dot must not bypass the suffix check
    ]) {
      await expect(assertPublicHost(host), host).rejects.toThrow(/blocked/);
    }
  });

  it('blocks a literal private address and allows a literal public one', async () => {
    await expect(assertPublicHost('169.254.169.254')).rejects.toThrow('blocked address');
    await expect(assertPublicHost('[::1]'.replace(/[[\]]/g, ''))).rejects.toThrow('blocked address');
    await expect(assertPublicHost('93.184.216.34')).resolves.toBeUndefined();
  });
});
