import { describe, it, expect, afterEach } from 'vitest';
import { buildCsp } from '../src/security-headers.js';
import { makeRelayApp, type TestApp } from '../../test/helpers/server.js';

let ctx: TestApp;
afterEach(async () => ctx && ctx.cleanup());

describe('buildCsp (API-only relay)', () => {
  it('denies every resource type — the relay serves no HTML', () => {
    const csp = buildCsp();
    expect(csp).toContain(`default-src 'none'`);
    expect(csp).toContain(`base-uri 'none'`);
    expect(csp).toContain(`form-action 'none'`);
    expect(csp).toContain(`frame-ancestors 'none'`);
  });

  it('carries no SPA-era directives or script allowances', () => {
    const csp = buildCsp();
    // These described a frontend this process no longer serves; keeping them
    // made a dead header look like a live defence (spec/security.md).
    for (const dead of ['script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'media-src', 'worker-src', 'manifest-src', 'frame-src', 'upgrade-insecure-requests']) {
      expect(csp).not.toContain(dead);
    }
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('sha256-');
  });
});

describe('security headers (served)', () => {
  it('sets CSP + hardening headers on API (JSON) responses', async () => {
    ctx = await makeRelayApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBe(buildCsp());
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});
