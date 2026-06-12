// The 8 preset note colors. Each maps to a global --brand-* custom property
// defined in style.css as a light-dark() pair, so rendered spans follow the
// active theme automatically and a palette retheme restyles existing notes.
export interface PresetColor {
  name: string;
  varName: string;
}

export const PRESET_COLORS: PresetColor[] = [
  { name: 'red', varName: '--brand-red' },
  { name: 'orange', varName: '--brand-orange' },
  { name: 'yellow', varName: '--brand-yellow' },
  { name: 'green', varName: '--brand-green' },
  { name: 'teal', varName: '--brand-teal' },
  { name: 'blue', varName: '--brand-blue' },
  { name: 'purple', varName: '--brand-purple' },
  { name: 'pink', varName: '--brand-pink' },
];

export function presetCss(p: PresetColor): string {
  return `var(${p.varName})`;
}

// Custom picks carry both theme values inline; light-dark() resolves against
// the color-scheme set in style.css for :root/.dark.
export function customCss(light: string, dark: string): string {
  return `light-dark(${light}, ${dark})`;
}

const LAST_KEY = 'notes:last-color';

export function getLastColor(): string {
  return localStorage.getItem(LAST_KEY) ?? `var(${PRESET_COLORS[5]!.varName})`;
}

export function setLastColor(css: string): void {
  localStorage.setItem(LAST_KEY, css);
}
