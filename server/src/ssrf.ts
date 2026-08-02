// SSRF guards for the server's outbound-fetch surfaces (the link-preview proxy
// is the one that fetches an attacker-supplied URL; the GIF/emote proxies only
// ever talk to a fixed upstream host).
//
// Two layers, both required:
//   1. `assertPublicHost()` — a fast pre-check on the URL's hostname.
//   2. `publicOnlyLookup`   — installed as the undici Agent connect-time DNS
//      hook, so the IP the socket ACTUALLY connects to is re-validated. This is
//      the authoritative guard: it closes the DNS-rebinding TOCTOU where a host
//      passes the pre-check with a public record and then resolves to
//      127.0.0.1 / 169.254.169.254 for the real request.

import dns from 'node:dns/promises';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

export function isPrivateIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-net, private, loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking (198.18/15)
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

/** Expand an IPv6 address to its 8 16-bit groups (null if it isn't parseable). */
function ipv6Groups(ip: string): number[] | null {
  const [head, tail] = ip.split('::') as [string, string | undefined];
  const parse = (s: string): number[] =>
    s
      .split(':')
      .filter((x) => x !== '')
      .map((x) => parseInt(x, 16));
  const a = parse(head);
  const b = tail === undefined ? [] : parse(tail);
  if (tail === undefined) return a.length === 8 ? a : null;
  const fill = 8 - a.length - b.length;
  if (fill < 0) return null;
  return [...a, ...Array<number>(fill).fill(0), ...b];
}

/** Dotted-quad for the low 32 bits of an expanded IPv6 address. */
function embeddedIpv4(groups: number[], at: number): string {
  const hi = groups[at] ?? 0;
  const lo = groups[at + 1] ?? 0;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

export function isPrivateIpv6(ip: string): boolean {
  const x = ip.toLowerCase().replace(/%.*$/, ''); // drop any zone id
  if (x === '::1' || x === '::') return true; // loopback / unspecified
  if (/^f[cd]/.test(x)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(x)) return true; // fe80::/10 link-local
  if (x.startsWith('ff')) return true; // multicast
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x); // IPv4-mapped
  if (mapped) return isPrivateIpv4(mapped[1]!);

  // Transition mechanisms embed an IPv4 address inside the v6 one; if the
  // embedded v4 is private, the connection lands on a private host even though
  // the outer address looks globally routable. Cover the three that matter:
  // NAT64 well-known prefix (64:ff9b::/96 and 64:ff9b:1::/48), 6to4 (2002::/16)
  // and the deprecated IPv4-compatible form (::a.b.c.d).
  const g = ipv6Groups(x.includes('.') ? toHexForm(x) : x);
  if (!g) return true; // unparseable → refuse
  if (g[0] === 0x0064 && g[1] === 0xff9b) return isPrivateIpv4(embeddedIpv4(g, 6));
  if (g[0] === 0x2002) return isPrivateIpv4(embeddedIpv4(g, 1));
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0 || g[5] === 0xffff)) {
    return isPrivateIpv4(embeddedIpv4(g, 6));
  }
  return false;
}

/** Rewrite a trailing dotted-quad in an IPv6 literal into two hex groups. */
function toHexForm(ip: string): string {
  return ip.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_m, a: string, b: string, c: string, d: string) => {
    const hi = ((Number(a) << 8) | Number(b)).toString(16);
    const lo = ((Number(c) << 8) | Number(d)).toString(16);
    return `${hi}:${lo}`;
  });
}

export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return isPrivateIpv4(ip);
  if (v === 6) return isPrivateIpv6(ip);
  return true; // not a literal IP → caller must resolve first
}

/** Throw unless every resolved address for the host is a public, routable IP.
 *  This is a fast pre-check; the authoritative guard is `publicOnlyLookup`. */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('blocked address');
    return;
  }
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal') ||
    lower.endsWith('.home.arpa') ||
    lower.endsWith('.in-addr.arpa') ||
    lower.endsWith('.ip6.arpa')
  ) {
    throw new Error('blocked host');
  }
  const records = await dns.lookup(hostname, { all: true });
  if (!records.length) throw new Error('no address');
  for (const r of records) if (isPrivateIp(r.address)) throw new Error('blocked address');
}

// undici invokes this for every outbound connection the fetch makes, so the IP
// the socket *actually* connects to is validated at connect time. TLS SNI is
// preserved (undici still uses the hostname), so HTTPS works.
type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;
export function publicOnlyLookup(
  hostname: string,
  options: { all?: boolean },
  callback: LookupCb,
): void {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    if (!addresses.length) return callback(new Error('no address') as NodeJS.ErrnoException, '', 0);
    for (const a of addresses) {
      if (isPrivateIp(a.address)) {
        return callback(new Error('blocked address') as NodeJS.ErrnoException, '', 0);
      }
    }
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

/** undici dispatcher whose every connection is re-validated as public. */
export const ssrfSafeAgent = new Agent({ connect: { lookup: publicOnlyLookup } });
