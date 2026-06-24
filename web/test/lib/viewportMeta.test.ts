import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The viewport meta is the Android keyboard-fit path: `interactive-widget=
// resizes-content` shrinks the layout viewport when the on-screen keyboard
// opens, so `#app`/`body` resize together instead of leaving a blank scrollable
// strip below the shell (the default `resizes-visual` regression). iOS Safari
// ignores it and relies on lib/viewport.ts; see viewport.test.ts.
describe('index.html viewport meta', () => {
  // Vitest runs from the repo root; the web app's index.html lives under web/.
  const html = readFileSync(resolve(process.cwd(), 'web/index.html'), 'utf8');
  const viewport = html.match(/name="viewport"[\s\S]*?content="([^"]*)"/)?.[1] ?? '';

  it('opts Android into resizing the layout viewport for the keyboard', () => {
    expect(viewport).toContain('interactive-widget=resizes-content');
  });

  it('keeps the safe-area + responsive width directives', () => {
    expect(viewport).toContain('width=device-width');
    expect(viewport).toContain('viewport-fit=cover');
  });
});
