import { createHash } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { buildCsp, inlineScriptHashes } from '../src/security-headers.js';
import type { Config } from '../src/config.js';
import { makeApp, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

function cfg(over: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: '/tmp',
    appOrigin: 'https://notes.example.com',
    rpId: 'notes.example.com',
    appName: 'Notes',
    webDist: null,
    klipyApiKey: null,
    rateLimitMax: 1000,
    ...over,
  };
}

describe('inlineScriptHashes', () => {
  it('hashes inline scripts and skips external (src) ones', () => {
    const body = `(function(){return 1;})();`;
    const html = `<head><script>${body}</script><script type="module" src="/app.js"></script></head>`;
    const expected = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
    expect(inlineScriptHashes(html)).toEqual([expected]);
  });

  it('returns [] when there are no inline scripts', () => {
    expect(inlineScriptHashes('<script src="/a.js"></script>')).toEqual([]);
  });

  it('handles end tags with trailing whitespace/garbage before > (js/bad-tag-filter)', () => {
    const body = `doThing();`;
    const expected = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
    // HTML treats `</script foo\n>` as a valid close; the body must not bleed past it.
    expect(inlineScriptHashes(`<script>${body}</script foo\n>`)).toEqual([expected]);
    expect(inlineScriptHashes(`<script>${body}</script\t>`)).toEqual([expected]);
  });
});

describe('buildCsp', () => {
  it('folds script hashes into script-src and never allows unsafe-inline for scripts', () => {
    const csp = buildCsp(cfg(), [`'sha256-abc'`]);
    expect(csp).toContain(`script-src 'self' 'wasm-unsafe-eval' 'sha256-abc'`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('allows WebAssembly via wasm-unsafe-eval but not full JS eval', () => {
    const csp = buildCsp(cfg(), []);
    expect(csp).toContain(`'wasm-unsafe-eval'`); // Argon2id (hash-wasm) + RNNoise denoiser
    // The broad 'unsafe-eval' (which would permit eval()/new Function()) must NOT
    // be granted — only the WASM-scoped variant. ('wasm-unsafe-eval' does not
    // contain the quoted token 'unsafe-eval'.)
    expect(csp).not.toContain(`'unsafe-eval'`);
  });

  it('names the wss origin in connect-src and upgrades on https', () => {
    const csp = buildCsp(cfg(), []);
    expect(csp).toContain(`connect-src 'self' wss://notes.example.com`);
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).toContain(`frame-ancestors 'none'`);
    // GIF CDN + click-to-load OG images load cross-origin over https.
    expect(csp).toContain(`img-src 'self' blob: data: https:`);
  });

  it('uses ws:// and omits HSTS upgrade for a plain-http origin', () => {
    const csp = buildCsp(cfg({ appOrigin: 'http://localhost:3000' }), []);
    expect(csp).toContain('connect-src \'self\' ws://localhost:3000');
    expect(csp).not.toContain('upgrade-insecure-requests');
  });
});

describe('security headers (served)', () => {
  it('sets CSP with the served index.html inline-script hash + hardening headers', async () => {
    ctx = await makeApp(); // fixture webdist has one inline script
    const res = await ctx.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toBeTruthy();
    // The fixture's inline theme script is allowed by hash, not unsafe-inline.
    const inline = `(function(){try{document.documentElement.classList.add('x');}catch(e){}})();`;
    const hash = `'sha256-${createHash('sha256').update(inline, 'utf8').digest('base64')}'`;
    expect(csp).toContain(hash);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('also sets CSP on API (JSON) responses', async () => {
    ctx = await makeApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toContain(`default-src 'self'`);
  });
});
