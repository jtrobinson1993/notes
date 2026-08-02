// The 7TV emote image proxy (emotes.ts).
//
// The property under test is the one that keeps this from being an open proxy:
// an emote id is a 26-char Crockford ULID and nothing else, so the outbound URL
// is always 7TV's CDN. An id that could carry `/`, `@`, `?` or `..` would let a
// caller steer the relay's request at an arbitrary host — the relay has a public
// IP and sits inside the operator's network, which is the whole point of SSRF.
//
// Every negative case asserts `fetch` was never called, not merely that the
// result was an error: "refused, but only after the request went out" is not a
// refusal.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureEmoteCached, emoteCachePath, EMOTE_ID_RE } from '../src/emotes.js';

const dirs: string[] = [];
function cacheDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'emote-cache-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const VALID = '01H8XGJWBWBAQ4M2CTNTQ7N7TZ'; // 26 chars, Crockford alphabet

// Ids that are rejected. Each is a way to reach a host other than 7TV's CDN, or
// a file other than the intended one, if the id were ever interpolated raw.
const HOSTILE = [
  ['empty', ''],
  ['too short', '01H8XGJWBWBAQ4M2CTNTQ7N7T'],
  ['too long', '01H8XGJWBWBAQ4M2CTNTQ7N7TZZ'],
  ['excluded letters (I/L/O/U are not Crockford)', '01H8XGJWBWBAQ4M2CTNTQ7N7IL'],
  ['lowercase', '01h8xgjwbwbaq4m2ctntq7n7tz'],
  ['path traversal', '../../../../etc/passwd'],
  ['host steering via slash', '01H8XGJWBWBAQ4M2CTNTQ7N7TZ/../../evil.example.com/x'],
  ['host steering via userinfo', '01H8XGJWBWBAQ4M2CTNTQ7N7TZ@evil.example.com'],
  ['query append', '01H8XGJWBWBAQ4M2CTNTQ7N7TZ?x=y'],
  ['fragment append', '01H8XGJWBWBAQ4M2CTNTQ7N7TZ#x'],
  ['scheme break', 'https://evil.example.com/a'],
  ['newline injection', '01H8XGJWBWBAQ4M2CTNTQ7N7TZ\n'],
] as const;

describe('emote id allowlist', () => {
  it('accepts a well-formed ULID', () => {
    expect(EMOTE_ID_RE.test(VALID)).toBe(true);
  });

  for (const [label, id] of HOSTILE) {
    it(`rejects ${label} without making any outbound request`, async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const out = await ensureEmoteCached(cacheDir(), id);

      expect(out).toEqual({ ok: false, reason: 'invalid-id' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  for (const [label, id] of HOSTILE) {
    it(`never yields a cache path for ${label}`, () => {
      expect(emoteCachePath(cacheDir(), id)).toBeNull();
    });
  }
});

describe('emote fetch target', () => {
  it('requests exactly 7TV’s CDN for a valid id', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'image/webp' }),
      arrayBuffer: async () => new TextEncoder().encode('webp-bytes').buffer,
    }));
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    const out = await ensureEmoteCached(cacheDir(), VALID);

    expect(out.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toBe(`https://cdn.7tv.app/emote/${VALID}/2x.webp`);
    // Belt and braces: whatever else changes, the origin may not.
    expect(new URL(url).origin).toBe('https://cdn.7tv.app');
  });

  it('refuses a response that is not an image', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => new ArrayBuffer(8),
      })) as unknown as typeof fetch,
    );

    const out = await ensureEmoteCached(cacheDir(), VALID);
    expect(out).toEqual({ ok: false, reason: 'not-an-image' });
  });

  it('refuses an oversized image rather than caching it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'image/webp' }),
        arrayBuffer: async () => new ArrayBuffer(2 * 1024 * 1024),
      })) as unknown as typeof fetch,
    );

    const out = await ensureEmoteCached(cacheDir(), VALID);
    expect(out).toEqual({ ok: false, reason: 'too-large' });
  });
});
