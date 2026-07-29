import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { devCspHeader, inlineScriptHashes, withScriptHashes } from '../../csp';
import { embedSrc } from '../../src/lib/editor/media';

// The native webview's Content-Security-Policy (spec/security.md § Hardening
// headers and the webview CSP). These are the *invariants* of the policy — the
// properties that must survive anyone editing the string. Whether the app still
// loads under it is a browser question, answered by `node web/dev/csp-probe.mjs`
// (Chromium + WebKit), not by jsdom.

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const conf = JSON.parse(read('../../../src-tauri/tauri.conf.json')) as {
  app: { security: { csp: string; devCsp: string } };
};

/** directive name → source list */
function parse(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

const prod = parse(conf.app.security.csp);
const dev = parse(conf.app.security.devCsp);

describe('native webview CSP', () => {
  it('is set at all (the shell must not ship csp: null)', () => {
    expect(conf.app.security.csp).toBeTruthy();
    expect(conf.app.security.devCsp).toBeTruthy();
  });

  it('denies everything by default and allow-lists per resource type', () => {
    expect(prod['default-src']).toEqual(["'none'"]);
    // Every directive the app relies on must be named explicitly — a resource
    // type that falls through to default-src 'none' is a silent breakage.
    for (const d of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src', 'connect-src', 'worker-src']) {
      expect(prod[d], `${d} must be explicit under default-src 'none'`).toBeDefined();
    }
  });

  it('never allows inline or eval\'d script', () => {
    // Tauri appends 'self' + a sha256 per inline <script> at build time; the
    // configured value must not widen that.
    expect(prod['script-src']).toEqual(["'self'"]);
    expect(dev['script-src']).toEqual(["'self'"]);
    for (const csp of [conf.app.security.csp, conf.app.security.devCsp]) {
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      expect(csp).not.toContain("'unsafe-eval'");
      // No WebAssembly runs in the webview (Argon2id lives in the Rust core);
      // if that changes this must be a deliberate edit, not a drift.
      expect(csp).not.toContain("'wasm-unsafe-eval'");
    }
  });

  it('keeps the webview off the network — only the Tauri IPC protocol', () => {
    // All relay traffic (and every remote fetch, including emote/GIF bytes) goes
    // through the Rust core, so the document itself may not open a connection to
    // any origin. `ipc:` / `http://ipc.localhost` is invoke()'s own transport.
    expect(prod['connect-src']).toEqual(['ipc:', 'http://ipc.localhost']);
    expect(prod['connect-src']).not.toContain('https:');
    expect(prod['connect-src']).not.toContain('wss:');
  });

  it('allows decrypted local media as blob:/data: but no remote media', () => {
    // Attachments and avatars decrypt in the core and are handed to the webview
    // as bytes; the UI renders them from object/data URLs.
    expect(prod['img-src']).toEqual(expect.arrayContaining(["'self'", 'data:', 'blob:']));
    expect(prod['media-src']).toEqual(["'self'", 'blob:']);
    expect(prod['font-src']).toEqual(["'self'"]); // self-hosted Geist, no CDN
  });

  it('allows remote images over https only (user-gated click-to-load)', () => {
    // The one remaining direct-to-internet load: `![](https://…)` in a note or
    // message, behind the click-to-load gate. Plain http is not allowed, and no
    // relay origin is named — see spec/security.md for the tradeoff.
    expect(prod['img-src']).toContain('https:');
    expect(prod['img-src']).not.toContain('http:');
    expect(prod['img-src']).not.toContain('*');
  });

  it('frames only the two privacy-friendly video embed origins the editor writes', () => {
    const allowed = prod['frame-src'] ?? [];
    for (const embed of [
      { platform: 'youtube', id: 'abcdef' },
      { platform: 'vimeo', id: '123456' },
    ] as const) {
      expect(allowed).toContain(new URL(embedSrc(embed)).origin);
    }
    expect(allowed).toHaveLength(2);
  });

  it('loads workers only from the bundle (E2EE voice frame crypto)', () => {
    expect(prod['worker-src']).toEqual(["'self'"]);
  });

  it('closes the classic injection escapes', () => {
    expect(prod['object-src']).toEqual(["'none'"]);
    expect(prod['base-uri']).toEqual(["'none'"]);
    expect(prod['form-action']).toEqual(["'none'"]);
    expect(prod['frame-ancestors']).toEqual(["'none'"]);
  });

  it('style-src is the one relaxation, and only for styles', () => {
    // CodeMirror's theme is injected at runtime as a <style> element by
    // style-mod, which no hash can cover. Inline *styles* cannot execute script.
    expect(prod['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('the dev policy differs from prod only by the dev server connection', () => {
    const { 'connect-src': prodConnect, ...prodRest } = prod;
    const { 'connect-src': devConnect, ...devRest } = dev;
    expect(devRest).toEqual(prodRest);
    // HMR websocket + Vite's own /@vite requests, on top of the IPC transport.
    expect(devConnect).toEqual(expect.arrayContaining(prodConnect ?? []));
    expect(devConnect).toContain('ws://localhost:5173');
  });
});

describe('dev-server CSP header', () => {
  const index = read('../../index.html');

  it('hashes inline scripts and skips external ones', () => {
    const body = '\n  var a = 1;\n';
    const html = `<script>${body}</script><script type="module" src="/src/main.ts"></script>`;
    expect(inlineScriptHashes(html)).toEqual([
      `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`,
    ]);
  });

  it('normalizes CRLF/CR to LF like tauri-codegen does', () => {
    const lf = inlineScriptHashes('<script>a();\nb();</script>');
    expect(inlineScriptHashes('<script>a();\r\nb();</script>')).toEqual(lf);
    expect(inlineScriptHashes('<script>a();\rb();</script>')).toEqual(lf);
  });

  it('ignores empty scripts and end tags with garbage before > (js/bad-tag-filter)', () => {
    expect(inlineScriptHashes('<script></script>')).toEqual([]);
    const one = inlineScriptHashes('<script>go();</script>');
    expect(inlineScriptHashes('<script>go();</script foo\n>')).toEqual(one);
  });

  it('folds the hashes into script-src and leaves other directives alone', () => {
    const out = withScriptHashes("default-src 'none'; script-src 'self'; img-src 'self'", ["'sha256-x'"]);
    expect(out).toBe("default-src 'none'; script-src 'self' 'sha256-x'; img-src 'self'");
    expect(withScriptHashes("script-src 'self'", [])).toBe("script-src 'self'");
  });

  it('serves the shell devCsp with a hash for the real index.html theme script', () => {
    const header = devCspHeader(conf.app.security, index)!;
    expect(header.startsWith("default-src 'none'; script-src 'self' 'sha256-")).toBe(true);
    // Exactly one inline script ships in index.html (the pre-paint theme
    // applier); anything else added there is a deliberate change.
    expect(inlineScriptHashes(index)).toHaveLength(1);
  });

  it('prefers devCsp but falls back to the production policy', () => {
    expect(devCspHeader({ csp: "img-src 'self'", devCsp: "img-src *" }, '')).toBe('img-src *');
    expect(devCspHeader({ csp: "img-src 'self'" }, '')).toBe("img-src 'self'");
    expect(devCspHeader({ csp: null }, '')).toBeNull();
  });
});
