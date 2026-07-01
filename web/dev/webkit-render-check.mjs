// Tier-3 "does the editor survive Linux WebKit" check for the Tauri decision
// (roadmap D1). Runs the standalone editor harness in BOTH Linux Chromium and
// Linux WebKit — inside the Playwright Linux container, `webkit` is the real
// WebKitGTK/WPE-lineage build, the same engine family Tauri renders with on
// Linux. Produces:
//
//   1. Screenshots of the live-preview + source editor per engine (eyeball the
//      concealed-marker rendering: bullets, checkboxes, headings, quotes).
//   2. A caret-offset PARITY check: the same key-motion scenarios on both
//      engines. Caret motion across concealed atomic widgets depends on real
//      layout geometry (web/dev/README.md), so a WebKit-vs-Chromium offset
//      divergence is the sharpest headless "behaves differently on Linux WebKit"
//      signal.
//   3. A construct probe: set each markdown construct on its own and report
//      which (if any) throws — this is engine-independent editor behaviour, but
//      cheap to capture while we're here.
//
// Prereq: dev server reachable (host runs `npm run dev -w web -- --host 0.0.0.0`).
// Run inside the Playwright Linux image; point HARNESS_URL at the host LAN IP
// (Vite 403s the `host.docker.internal` Host header).
import { chromium, webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const TARGET = process.env.HARNESS_URL ?? 'http://host.docker.internal:5173/dev/editor-harness.html';
const OUT = new URL('./out/', import.meta.url).pathname;

// Concealment-heavy but block-decoration-safe document (fenced code + thematic
// break are excluded — they throw in the live-preview plugin; see CONSTRUCTS).
const RICH = [
  '# Heading one',
  '## Heading two',
  '',
  'Text with **bold**, *italic*, `inline code`, and a [link](https://example.com).',
  '',
  '- bullet one',
  '- bullet two',
  '  - nested bullet',
  '',
  '- [ ] unchecked task',
  '- [x] checked task',
  '',
  '> a blockquote line',
  '',
  '1. first ordered',
  '2. second ordered',
].join('\n');

// Caret-motion scenarios (doc, starting caret, key, presses). From
// editor-probe.mjs plus a couple that cross concealed inline markers.
const SCENARIOS = [
  { doc: '\n- item', caret: 3, key: 'ArrowLeft', presses: 4 },
  { doc: '\n- [ ] todo', caret: 7, key: 'ArrowLeft', presses: 4 },
  { doc: 'a **bold** b', caret: 0, key: 'ArrowRight', presses: 12 },
  { doc: '# Title', caret: 0, key: 'ArrowRight', presses: 7 },
];

// Individual constructs, each set in isolation to find what throws.
const CONSTRUCTS = {
  heading: '# Title',
  bulletList: '- one\n- two',
  checkbox: '- [ ] todo',
  blockquote: '> quote',
  orderedList: '1. one\n2. two',
  inlineMarks: 'a **b** *c* `d` [e](http://x)',
  fencedCode: '```js\nconst x = 1;\n```',
  thematicBreak: 'a\n\n---\n\nb',
  setextRule: 'a\n\n***\n\nb',
};

async function open(launcher) {
  const browser = await launcher.launch();
  const page = await browser.newPage({ viewport: { width: 820, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(TARGET, { waitUntil: 'networkidle' });
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  return { browser, page, pageErrors };
}

async function setDoc(page, doc, caret = 0) {
  // __setDoc dispatches into CodeMirror; a bad construct throws synchronously in
  // page context, rejecting the evaluate — surface it as a JS error string.
  try {
    await page.evaluate(([d, c]) => window.__setDoc(d, c), [doc, caret]);
    await page.waitForTimeout(60);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e).split('\n')[0] };
  }
}

async function drive(engine, launcher) {
  const { browser, page } = await open(launcher);

  // --- Screenshots: live then source (resilient to a throw) ---
  const live = await setDoc(page, RICH, 0);
  if (!live.ok) console.log(`[${engine}] live setDoc threw: ${live.error}`);
  await page.evaluate(() => document.fonts.ready); // web fonts loaded before capture
  const diag = await page.evaluate(() => {
    const h = document.querySelector('.cm-live-h1');
    const cs = h ? getComputedStyle(h) : null;
    return {
      h1FontFamily: cs?.fontFamily,
      h1FontWeight: cs?.fontWeight,
      sans400: document.fonts.check("400 16px 'Geist Variable'"),
      sans700: document.fonts.check("700 16px 'Geist Variable'"),
      mono: document.fonts.check("400 16px 'Geist Mono Variable'"),
    };
  });
  console.log(`[${engine}] FONT DIAG:`, JSON.stringify(diag));
  await page.locator('.cm-content').screenshot({ path: `${OUT}${engine}-live.png` });

  await page.selectOption('select', 'source');
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await setDoc(page, RICH, 0);
  await page.evaluate(() => document.fonts.ready);
  await page.locator('.cm-content').screenshot({ path: `${OUT}${engine}-source.png` });

  await page.selectOption('select', 'live');
  await page.waitForSelector('.cm-content', { timeout: 20000 });
  await page.click('.cm-content');

  // --- Caret parity ---
  const results = [];
  for (const s of SCENARIOS) {
    await setDoc(page, s.doc, s.caret);
    const start = await page.evaluate(() => window.__caret());
    const heads = [];
    for (let i = 0; i < s.presses; i++) {
      await page.keyboard.press(s.key);
      await page.waitForTimeout(25);
      heads.push(await page.evaluate(() => window.__caret()));
    }
    results.push({ ...s, start, heads });
  }
  await browser.close();
  return results;
}

async function probeConstructs(launcher) {
  const { browser, page } = await open(launcher);
  const out = {};
  for (const [name, doc] of Object.entries(CONSTRUCTS)) {
    // remount a clean editor per construct so one throw doesn't poison the next
    await page.selectOption('select', 'source');
    await page.waitForSelector('.cm-content');
    await page.selectOption('select', 'live');
    await page.waitForSelector('.cm-content');
    out[name] = await setDoc(page, doc, 0);
  }
  await browser.close();
  return out;
}

await mkdir(OUT, { recursive: true });
console.log('URL:', TARGET);

const constructs = await probeConstructs(chromium);
const chrome = await drive('chromium', chromium);
const wk = await drive('webkit', webkit);

// Caret parity comparison.
let diffs = 0;
const report = SCENARIOS.map((s, i) => {
  const a = chrome[i], b = wk[i];
  const same = a.start === b.start && JSON.stringify(a.heads) === JSON.stringify(b.heads);
  if (!same) diffs++;
  return { scenario: `${JSON.stringify(s.doc)} ${s.key}x${s.presses}`, chromium: { start: a.start, heads: a.heads }, webkit: { start: b.start, heads: b.heads }, match: same };
});
await writeFile(`${OUT}caret-parity.json`, JSON.stringify({ constructs, report }, null, 2));

console.log('\n=== CONSTRUCT PROBE (engine-independent editor behaviour) ===');
for (const [name, r] of Object.entries(constructs)) {
  console.log(`${r.ok ? 'ok  ' : 'THROW'} ${name}${r.ok ? '' : '  → ' + r.error}`);
}

console.log('\n=== CARET PARITY (Linux Chromium vs Linux WebKit) ===');
for (const r of report) {
  console.log(`${r.match ? 'PASS' : 'DIFF'}  ${r.scenario}`);
  if (!r.match) {
    console.log(`   chromium: start=${r.chromium.start} heads=${JSON.stringify(r.chromium.heads)}`);
    console.log(`   webkit:   start=${r.webkit.start} heads=${JSON.stringify(r.webkit.heads)}`);
  }
}
console.log(`\ncaret parity: ${diffs === 0 ? 'ALL PASS' : diffs + ' DIFFERENCE(S)'} — screenshots + json in web/dev/out/`);
