export type Theme = 'system' | 'light' | 'dark';

const KEY = 'notes:theme';

export function getTheme(): Theme {
  const t = localStorage.getItem(KEY);
  return t === 'light' || t === 'dark' ? t : 'system';
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
  apply();
}

function apply(): void {
  const theme = getTheme();
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

export function initTheme(): void {
  // theme token layer (--brand-* palette in style.css); future selectable
  // themes will swap this attribute
  document.documentElement.dataset.theme = 'default';
  apply();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
}
