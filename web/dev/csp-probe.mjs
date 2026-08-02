// CSP smoke probe — loads the app under the *exact* Content-Security-Policy the
// native shell ships (src-tauri/tauri.conf.json) and reports every violation.
//
// The webview CSP is the one piece of hardening that fails *silently*: a
// too-tight policy doesn't crash, it just stops an avatar, an attachment, the
// voice worker or the editor's stylesheet from loading. So the policy is
// verified against a real browser rather than by reading it.
//
//   node web/dev/csp-probe.mjs          # prod policy against web/dist
//   node web/dev/csp-probe.mjs --dev    # dev policy against a running dev server
//
// Prod mode serves `web/dist` from a throwaway static server that reproduces
// what Tauri does at runtime: the CSP goes out as a response header on HTML
// only, with a `'sha256-…'` for every inline <script> in the document appended
// to `script-src` (tauri-codegen `inject_script_hashes` — same normalization,
// CRLF → LF). Dev mode expects `npm run dev:web` (or `dev:native`) on :5173 and
// uses the policy Vite itself sends (see web/vite.config.ts).
//
// Both engines are exercised: Chromium stands in for WebView2 (Windows) and
// WebKit for WKWebView / WebKitGTK (macOS + Linux) — CSP enforcement differs
// between them, so a Chromium-only pass proves nothing about the Mac build.
//
// Exit code is non-zero if any violation was seen.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST = join(ROOT, 'web/dist');
const DEV = process.argv.includes('--dev');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/** The policy the native shell ships, straight from the Tauri config. `CSP=…`
 *  overrides it, which is how you check the probe still *catches* things: drop
 *  a directive and confirm the run goes red. */
async function policy() {
  if (process.env.CSP) return process.env.CSP;
  const conf = JSON.parse(await readFile(join(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
  const { csp, devCsp } = conf.app.security;
  return DEV ? (devCsp ?? csp) : csp;
}

/** Tauri hashes every non-empty inline <script> of a bundled HTML asset and
 *  appends the hashes to script-src at runtime; mirror that so the probe tests
 *  the policy as *shipped*, not a stricter fiction. */
function withInlineScriptHashes(csp, html) {
  const hashes = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1] ?? '')) continue;
    const body = (m[2] ?? '').replace(/\r\n?/g, '\n');
    if (!body) continue;
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  if (!hashes.length) return csp;
  return csp
    .split(';')
    .map((d) => (d.trim().startsWith('script-src') ? `${d.trimEnd()} ${hashes.join(' ')}` : d))
    .join(';');
}

async function serveDist(csp) {
  const index = await readFile(join(DIST, 'index.html'), 'utf8');
  const htmlCsp = withInlineScriptHashes(csp, index);
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = rel === '/' ? join(DIST, 'index.html') : join(DIST, rel);
    readFile(file).then(
      (body) => {
        const ext = extname(file);
        // Tauri sets the CSP header on HTML assets only.
        if (ext === '.html') res.setHeader('Content-Security-Policy', htmlCsp);
        res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
        res.end(body);
      },
      () => {
        res.statusCode = 404;
        res.end('not found');
      },
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close(), htmlCsp };
}

/** Path of the built voice frame Worker chunk (same-origin module worker). */
async function workerPath() {
  if (DEV) return '/src/lib/voiceFrameWorker.ts';
  const files = await readdir(join(DIST, 'assets'));
  const hit = files.find((f) => f.startsWith('voiceFrameWorker-') && f.endsWith('.js'));
  return hit ? `/assets/${hit}` : null;
}

const VIOLATION_RE = /content security policy|Refused to|blocked by CSP|CSP directive/i;

// Exercise the resource types the shell loads that a bare page load never
// touches: data: images (avatars), blob: images and media (decrypted
// attachments), the same-origin module Worker (E2EE voice frame crypto), and
// CodeMirror's runtime <style> injection via style-mod (the editor theme).
const exercise = (worker) => async (page) =>
  page.evaluate(async (workerUrl) => {
    const out = {};
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bytes = Uint8Array.from(atob(png.slice(png.indexOf(',') + 1)), (c) => c.charCodeAt(0));
    const settle = (el, src) =>
      new Promise((res) => {
        el.onload = () => res('ok');
        el.onerror = () => res('blocked');
        el.src = src;
        document.body.append(el);
        setTimeout(() => res('timeout'), 1500);
      });
    out.dataImg = await settle(new Image(), png);
    out.blobImg = await settle(new Image(), URL.createObjectURL(new Blob([bytes], { type: 'image/png' })));
    // A <video> with a blob: source: metadata never parses (not real media), so
    // "decode error" is the pass — a CSP block surfaces as a violation event,
    // and MEDIA_ERR_SRC_NOT_SUPPORTED is what a blocked source also yields, so
    // the securitypolicyviolation list below is the authority here.
    const video = document.createElement('video');
    out.blobMedia = await new Promise((res) => {
      video.onloadedmetadata = () => res('ok');
      video.onerror = () => res(`media-error-${video.error?.code}`);
      video.src = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
      document.body.append(video);
      setTimeout(() => res('timeout'), 1500);
    });
    if (workerUrl) {
      try {
        const w = new Worker(workerUrl, { type: 'module' });
        out.moduleWorker = await new Promise((res) => {
          w.onerror = (e) => res(`error: ${e.message ?? ''}`);
          // The real worker only answers on protocol messages; loading without
          // an error event is the signal that worker-src allowed the script.
          setTimeout(() => res('loaded'), 800);
        });
        w.terminate();
      } catch (e) {
        out.moduleWorker = `throw: ${e}`;
      }
    }
    // Saving a file (Settings → export) is an <a download> pointed at an object
    // URL. Navigations aren't governed by CSP, but that is exactly the kind of
    // assumption worth having a probe for.
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['probe'], { type: 'text/plain' }));
    a.download = 'csp-probe.txt';
    document.body.append(a);
    a.click();
    out.blobDownload = 'clicked';
    // style-mod (CodeMirror): an empty <style> whose textContent is set from
    // JS. Blocked by style-src without 'unsafe-inline' — and it fails silently,
    // leaving the editor unstyled rather than throwing.
    const style = document.createElement('style');
    style.textContent = '.csp-probe-style{color:rgb(1,2,3)}';
    document.head.append(style);
    const el = document.createElement('div');
    el.className = 'csp-probe-style';
    document.body.append(el);
    out.injectedStyle = getComputedStyle(el).color === 'rgb(1, 2, 3)' ? 'applied' : 'BLOCKED';
    // Inline style attribute (Vue renders <span style="color:var(--brand-…)">).
    const attr = document.createElement('div');
    attr.setAttribute('style', 'color:rgb(4,5,6)');
    document.body.append(attr);
    out.styleAttr = getComputedStyle(attr).color === 'rgb(4, 5, 6)' ? 'applied' : 'BLOCKED';
    return out;
  }, worker);

async function probe(engine, name, url, run) {
  const browser = await engine.launch();
  const page = await browser.newPage();
  const violations = [];
  const errors = [];
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push({
        directive: e.effectiveDirective || e.violatedDirective,
        blocked: e.blockedURI,
        sample: e.sample,
      });
    });
  });
  const notes = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (VIOLATION_RE.test(t)) violations.push({ directive: '(console)', blocked: t.slice(0, 300) });
    // HMR's websocket is the dev-loop resource a connect-src slip would kill.
    else if (t.includes('[vite]')) notes.push(t.slice(0, 120));
  });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  page.on('requestfailed', (r) => errors.push(`requestfailed ${r.url().slice(0, 120)} ${r.failure()?.errorText}`));
  await page.goto(url, { waitUntil: 'load' });
  const resources = run ? await run(page) : null;
  await page.waitForTimeout(1200);
  violations.push(...(await page.evaluate(() => window.__csp ?? [])));
  const probes = await page.evaluate(() => {
    // CodeMirror's base theme is injected at runtime by style-mod, so
    // `.cm-editor { display: flex }` holding is proof the editor's stylesheet
    // survived style-src — the failure this policy is most likely to cause.
    const cm = document.querySelector('.cm-editor');
    return {
      fonts: document.fonts ? document.fonts.size : null,
      styleSheets: document.styleSheets.length,
      mounted: !!document.querySelector('#app')?.firstElementChild,
      editorThemed: cm ? getComputedStyle(cm).display === 'flex' : null,
    };
  });
  await browser.close();
  return { engine: name, url, violations, errors, probes, resources, notes };
}

const csp = await policy();
if (!csp) {
  console.error(`No ${DEV ? 'devCsp' : 'csp'} in src-tauri/tauri.conf.json`);
  process.exit(1);
}

let origin = 'http://localhost:5173';
let close = () => {};
let effective = csp;
if (!DEV) ({ origin, close, htmlCsp: effective } = await serveDist(csp));
const worker = await workerPath();

console.log(`policy (${DEV ? 'dev' : 'prod'}):\n  ${effective.replace(/;\s*/g, ';\n  ')}\n`);

const pages = DEV ? ['/', '/dev/editor-harness.html'] : ['/'];
const runs = [];
for (const [engine, name] of [
  [chromium, 'chromium'],
  [webkit, 'webkit'],
]) {
  for (const path of pages) {
    runs.push(await probe(engine, name, origin + path, path === '/' ? exercise(worker) : undefined));
  }
}
close();

let failed = 0;
for (const r of runs) {
  console.log(`── ${r.engine} ${new URL(r.url).pathname}`);
  console.log(`   probes:    ${JSON.stringify(r.probes)}`);
  if (r.resources) console.log(`   resources: ${JSON.stringify(r.resources)}`);
  for (const n of r.notes ?? []) console.log(`   console:   ${n}`);
  if (r.violations.length) {
    failed += r.violations.length;
    for (const v of r.violations) console.log(`   CSP VIOLATION ${v.directive} ← ${v.blocked} ${v.sample ?? ''}`);
  } else {
    console.log('   no CSP violations');
  }
  for (const e of r.errors) console.log(`   note: ${e}`);
}
process.exit(failed ? 1 : 0);
