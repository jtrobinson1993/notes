// Two independent axes:
//  - mode: light / dark / system (toggles the .dark class; drives color-scheme
//    and every `dark:` Tailwind variant)
//  - palette: the color theme (brand / pastel / high-contrast), applied as the
//    data-theme attribute. Each palette redefines the token layer in style.css
//    (the --brand-* note colors and the --color-zinc-* neutral ramp), so a
//    swap restyles the whole app — notes store only var() references, never
//    hexes. Both are device-local (localStorage), like the existing mode.

export type Theme = 'system' | 'light' | 'dark';
export type Palette = 'brand' | 'pastel' | 'high-contrast';

const MODE_KEY = 'notes:theme';
const PALETTE_KEY = 'notes:palette';

export function getTheme(): Theme {
  const t = localStorage.getItem(MODE_KEY);
  return t === 'light' || t === 'dark' ? t : 'system';
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(MODE_KEY, theme);
  apply();
}

export function getPalette(): Palette {
  const p = localStorage.getItem(PALETTE_KEY);
  return p === 'pastel' || p === 'high-contrast' ? p : 'brand';
}

export function setPalette(palette: Palette): void {
  localStorage.setItem(PALETTE_KEY, palette);
  apply();
}

function apply(): void {
  const theme = getTheme();
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = getPalette();
}

export function initTheme(): void {
  apply();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
}
