// Drive the standalone editor harness in a real browser (Chromium) and print
// the caret offset after each key press. Use this to verify caret / keymap /
// live-preview behaviour that jsdom can't model (it has no layout, so visual
// cursor motion across concealed widgets behaves differently there).
//
// Prereq: the web dev server is running (`npm run dev:web`, serves :5173).
// Run:    node web/dev/editor-probe.mjs
//         HARNESS_URL=http://localhost:5173/dev/editor-harness.html node web/dev/editor-probe.mjs
//
// Edit the SCENARIOS below (or import `probe` from your own script) to test a
// new case. Each scenario sets the document + caret, then presses a key N times
// and records the caret offset after each press.
import { chromium } from 'playwright';

const URL = process.env.HARNESS_URL ?? 'http://localhost:5173/dev/editor-harness.html';

/** Open one page; returns { probe, close }. `probe` runs a scenario and returns
 *  the caret offsets after each press (plus the final document). */
export async function openHarness() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('PAGEERR:', e.message));
  await page.goto(URL);
  await page.waitForSelector('.cm-content', { timeout: 15000 });
  await page.click('.cm-content');

  async function probe({ doc, caret = 0, key = 'ArrowLeft', presses = 1 }) {
    await page.evaluate(([d, c]) => window.__setDoc(d, c), [doc, caret]);
    await page.waitForTimeout(40);
    const start = await page.evaluate(() => window.__caret());
    const heads = [];
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press(key);
      await page.waitForTimeout(25);
      heads.push(await page.evaluate(() => window.__caret()));
    }
    return { doc, caret, key, start, heads, finalDoc: await page.evaluate(() => window.__doc()) };
  }

  return { page, probe, close: () => browser.close() };
}

const SCENARIOS = [
  { doc: '\n- item', caret: 3, key: 'ArrowLeft', presses: 4 },
  { doc: '\n- [ ] todo', caret: 7, key: 'ArrowLeft', presses: 4 },
  { doc: '\n- item', caret: 3, key: 'ArrowLeft', presses: 1 }, // then Backspace below
];

// Only auto-run the scenarios when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { page, probe, close } = await openHarness();
  for (const s of SCENARIOS) console.log(JSON.stringify(await probe(s)));
  // Headline check: ArrowLeft to before the marker, then Backspace removes the
  // blank line above while keeping the list.
  await page.evaluate(() => window.__setDoc('\n- item', 3));
  await page.waitForTimeout(40);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(40);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(40);
  console.log('Backspace-after-ArrowLeft →', JSON.stringify(await page.evaluate(() => window.__doc())));
  await close();
}
