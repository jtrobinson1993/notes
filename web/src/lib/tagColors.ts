import { reactive } from 'vue';
import { settingsGet, settingsSet } from './native';
import { PRESET_COLORS, presetCss } from './editor/palette';

// Per-tag pill colors, chosen via the pill's color popover. Values are the
// same theme-aware CSS strings the text palette produces (var(--brand-*) or
// light-dark(...)); tags without a stored color get a stable preset hashed
// from their name.
//
// The blob lives in the encrypted vault (SQLCipher `settings`, via the Rust
// core) — the KEYS are tag names, which are as sensitive as note bodies, so
// there is deliberately no plaintext localStorage cache.

const SETTING_KEY = 'tag-colors';

const stored = reactive<Record<string, string>>({});

let pushTimer: ReturnType<typeof setTimeout> | null = null;

async function pushRemote(): Promise<void> {
  await settingsSet(SETTING_KEY, JSON.stringify({ ...stored })).catch(() => {});
}

function schedulePush(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void pushRemote(), 1000);
}

let loaded = false;

/** Read the stored colors out of the encrypted vault (once per unlock). */
export async function loadTagColors(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await settingsGet(SETTING_KEY);
    if (raw) Object.assign(stored, JSON.parse(raw) as Record<string, string>);
  } catch {
    loaded = false; // transient: retry on the next call
  }
}

/** Drop the decrypted tag names on lock — they must not outlive the vault key.
 *  Any pending debounced write is cancelled (it would fail against a locked
 *  vault anyway, and could otherwise fire after a switch to another account). */
export function resetTagColors(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
  loaded = false;
  for (const k of Object.keys(stored)) delete stored[k];
}

export function tagColor(tag: string): string {
  const custom = stored[tag];
  if (custom) return custom;
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return presetCss(PRESET_COLORS[h % PRESET_COLORS.length]!);
}

export function setTagColor(tag: string, color: string): void {
  stored[tag] = color;
  schedulePush();
}

export function clearTagColor(tag: string): void {
  delete stored[tag];
  schedulePush();
}

// Resolve a palette CSS value (#hex, var(--brand-*), light-dark(a, b)) to a
// concrete hex for the active theme.
function resolveHex(css: string): string | null {
  let v = css.trim();
  const varMatch = /^var\((--[\w-]+)\)$/.exec(v);
  if (varMatch) v = getComputedStyle(document.documentElement).getPropertyValue(varMatch[1]!).trim();
  const ld = /^light-dark\(\s*([^,]+),\s*([^)]+)\)$/.exec(v);
  if (ld) v = (document.documentElement.classList.contains('dark') ? ld[2]! : ld[1]!).trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
}

// Black or white text, whichever contrasts better (WCAG relative luminance).
export function tagTextColor(css: string): string {
  const hex = resolveHex(css);
  if (!hex) return '#fff';
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
  return l > 0.35 ? '#000' : '#fff';
}
