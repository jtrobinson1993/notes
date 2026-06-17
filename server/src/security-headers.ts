import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';

// Content-Security-Policy + companion hardening headers, set on every response
// as defense-in-depth (see spec/security.md). The policy is strict: no inline
// or eval'd script. index.html ships exactly one (or a few) inline <script>
// blocks — the pre-paint theme applier, and the PWA service-worker registration
// injected by vite-plugin-pwa — which we allow by their SHA-256 hashes rather
// than 'unsafe-inline', so an injected <script> still can't run.

/** SHA-256-base64 CSP source tokens for every inline (no `src`) <script> in the
 * served index.html. Computed once at boot from the exact bytes on disk, so it
 * tracks whatever the build emits; a one-character change invalidates the hash
 * (which is the point — a tampered/injected script won't match). */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue; // external script — covered by 'self'
    const body = m[2] ?? '';
    const digest = createHash('sha256').update(body, 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

/** Build the CSP header value. `scriptHashes` are folded into `script-src`. */
export function buildCsp(config: Config, scriptHashes: string[]): string {
  const url = new URL(config.appOrigin);
  const isHttps = url.protocol === 'https:';
  // The chat WebSocket connects to our own origin; CSP's connect-src 'self' is
  // inconsistent about ws(s): across browsers, so name the origin explicitly.
  const wsOrigin = `${isHttps ? 'wss' : 'ws'}://${url.host}`;
  const scriptSrc = ["'self'", ...scriptHashes].join(' ');

  const directives = [
    `default-src 'self'`,
    `base-uri 'self'`,
    `script-src ${scriptSrc}`,
    // Vue / reka-ui apply runtime styles via injected <style> and style attrs;
    // 'unsafe-inline' here is far lower-risk than for scripts (no code exec).
    `style-src 'self' 'unsafe-inline'`,
    // 'self' for our own assets (emoji proxy, decrypted blobs as blob:/data:);
    // https: is required for the KLIPY GIF CDN and click-to-load OG preview
    // images, which the browser loads cross-origin straight from their source.
    `img-src 'self' blob: data: https:`,
    `font-src 'self' data:`,
    `connect-src 'self' ${wsOrigin}`,
    `media-src 'self' blob:`,
    `worker-src 'self'`,
    `manifest-src 'self'`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  if (isHttps) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

/** Register the CSP + hardening headers on every response. `indexHtml` is the
 * served SPA shell (or null when serving API-only / in dev), used only to hash
 * its inline scripts for script-src. */
export function registerSecurityHeaders(
  app: FastifyInstance,
  config: Config,
  indexHtml: string | null,
): void {
  const csp = buildCsp(config, indexHtml ? inlineScriptHashes(indexHtml) : []);
  const isHttps = config.appOrigin.startsWith('https://');

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('Content-Security-Policy', csp);
    reply.header('X-Content-Type-Options', 'nosniff');
    // We make outbound cross-origin image loads (GIF CDN, OG images); no-referrer
    // keeps the app's URLs out of those requests.
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    if (isHttps) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });
}
