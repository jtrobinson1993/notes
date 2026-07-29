// Dev-server Content-Security-Policy plumbing (build-time only — never bundled
// into the app; imported by vite.config.ts).
//
// A built app gets its CSP from Tauri: it serves index.html itself, sends
// `app.security.csp` as a response header, and appends a `'sha256-…'` source for
// every inline <script> in the document (tauri-codegen `inject_script_hashes`).
// Under `npm run dev:native` the webview loads the Vite dev server over http
// instead, so Tauri never sees the document and `devCsp` on its own applies to
// nothing. The dev policy therefore has to be sent by Vite — otherwise the loop
// developers actually use runs with no CSP and violations only appear in a
// release build.
//
// tauri.conf.json stays the single source of truth for the policy text; this
// module only reproduces Tauri's inline-script hashing on top of it.

import { createHash } from 'node:crypto';

/** SHA-256 CSP source tokens for every inline (no `src`) <script> in `html`.
 *  Line endings are normalized CRLF/CR → LF first, matching Tauri's
 *  `normalize_script_for_csp`, so a hash computed here is byte-identical to the
 *  one the bundled app ships. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  // The end tag must allow anything up to `>` after `script` (HTML treats
  // `</script foo\t>` as a valid close), not just whitespace.
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1] ?? '')) continue; // external — covered by 'self'
    const body = (m[2] ?? '').replace(/\r\n?/g, '\n');
    if (body) hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/** Fold script hashes into a policy's `script-src`. Returns the policy
 *  unchanged when there is nothing to add; never invents a `script-src`, since
 *  a policy without one has already fallen back to `default-src`. */
export function withScriptHashes(csp: string, hashes: string[]): string {
  if (!hashes.length) return csp;
  return csp
    .split(';')
    .map((d) => (d.trim().startsWith('script-src') ? `${d.trimEnd()} ${hashes.join(' ')}` : d))
    .join(';');
}

/** The header value the dev server sends: the shell's `devCsp` (falling back to
 *  the production `csp`), plus a hash per inline script in the dev `index.html`.
 *  `null` when the shell ships no policy at all. */
export function devCspHeader(
  security: { csp?: string | null; devCsp?: string | null },
  indexHtml: string,
): string | null {
  const csp = security.devCsp ?? security.csp;
  if (!csp) return null;
  return withScriptHashes(csp, inlineScriptHashes(indexHtml));
}
