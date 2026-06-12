import { reactive } from 'vue';
import { useSessionStore } from '../stores/session';
import { api } from './api';
import { unwrapKey, wrapKey } from './crypto';
import { PRESET_COLORS, presetCss } from './editor/palette';

// Per-tag pill colors, chosen via the pill's color popover. Values are the
// same theme-aware CSS strings the text palette produces (var(--brand-*) or
// light-dark(...)); tags without a stored color get a stable preset hashed
// from their name.
//
// Colors are synced server-side as an encrypted settings blob (tag names are
// sensitive — they otherwise only exist inside encrypted note payloads), with
// localStorage as an instant-load/offline cache.

const LOCAL_KEY = 'notes:tag-colors';
const SETTING_KEY = 'tag-colors';
const INFO_SETTINGS = 'notes:wrap:settings:v1';

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

const stored = reactive<Record<string, string>>(load());

function persistLocal(): void {
  localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...stored }));
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;

async function pushRemote(): Promise<void> {
  const session = useSessionStore();
  if (!session.mk) return;
  const wrapped = await wrapKey(session.mk, new TextEncoder().encode(JSON.stringify({ ...stored })), INFO_SETTINGS);
  await api.settingPut(SETTING_KEY, JSON.stringify(wrapped)).catch(() => {});
}

function schedulePush(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void pushRemote(), 1000);
}

let loaded = false;

/** Fetch and decrypt the server copy once the session is unlocked; local
 * entries missing from the server (offline edits) are pushed back. */
export async function loadTagColors(): Promise<void> {
  const session = useSessionStore();
  if (loaded || !session.mk) return;
  loaded = true;
  try {
    const remote = await api.settingGet(SETTING_KEY);
    if (!remote) {
      if (Object.keys(stored).length) schedulePush();
      return;
    }
    const pt = await unwrapKey(session.mk, JSON.parse(remote.data), INFO_SETTINGS);
    const colors = JSON.parse(new TextDecoder().decode(pt)) as Record<string, string>;
    const localOnly = Object.keys(stored).some((k) => !(k in colors));
    Object.assign(stored, colors);
    persistLocal();
    if (localOnly) schedulePush();
  } catch {
    loaded = false; // network/decrypt hiccup: retry on the next call
  }
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
  persistLocal();
  schedulePush();
}

export function clearTagColor(tag: string): void {
  delete stored[tag];
  persistLocal();
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
