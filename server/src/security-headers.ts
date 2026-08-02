import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';

// Content-Security-Policy + companion hardening headers, set on every response
// as defense-in-depth (see spec/security.md).
//
// The relay is API-only: JSON, an image endpoint and WebSockets, never an HTML
// document. So this policy governs no page, and the SPA-era directives it used
// to carry (script/style/img/font/connect sources, `worker-src`, `manifest-src`,
// the YouTube/Vimeo `frame-src`, inline-script hashes) were dead weight that
// read like a live defence. What is left is the floor that still means
// something if the process ever does emit HTML — by accident or by a future
// surface: nothing loads, nothing frames it, no form posts, no <base> rewrite.
// The CSP that actually defends the app is the **native webview's**, in
// src-tauri/tauri.conf.json.

/** Build the CSP header value (API-only; see the note above). */
export function buildCsp(): string {
  return [`default-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`].join('; ');
}

/** Register the CSP + hardening headers on every response. */
export function registerSecurityHeaders(app: FastifyInstance, config: Config): void {
  const csp = buildCsp();
  const isHttps = config.appOrigin.startsWith('https://');

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', csp);
    reply.header('X-Content-Type-Options', 'nosniff');
    // We make outbound cross-origin image loads (GIF CDN, OG images); no-referrer
    // keeps the app's URLs out of those requests.
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    // same-origin by default; a route may opt out by setting CORP itself (the
    // emote image proxy has to be loadable as an <img> from the native shell's
    // own origin). Only an explicit per-route decision can relax it.
    if (!reply.getHeader('Cross-Origin-Resource-Policy')) {
      reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    }
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    if (isHttps) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });
}
