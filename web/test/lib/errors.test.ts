import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { errorCatalog, errorEntry, errorMessage } from '../../src/lib/errors';

// The catalogue is what a user is shown and what the website publishes, so it
// is treated as a contract rather than a comment: every code referenced in the
// source must exist here, and every entry must be complete enough to be useful
// to someone who just hit the error.

// Vitest runs from the repo root (see vitest.config.ts projects).
const SRC = resolve(process.cwd(), 'web/src');

/** Every .ts/.vue file under web/src. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith('.ts') || e.name.endsWith('.vue')) out.push(p);
  }
  return out;
}

describe('error catalogue', () => {
  it('has a complete, useful entry for every code', () => {
    expect(Object.keys(errorCatalog).length).toBeGreaterThan(0);

    for (const [code, entry] of Object.entries(errorCatalog)) {
      expect(code, 'codes are SCREAMING_SNAKE so they are stable URL slugs').toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(entry.readableName, `${code}.readableName`).toBeTruthy();
      // A readable name is a sentence for a human, not a restated code.
      expect(entry.readableName, `${code}.readableName must not be the code`).not.toBe(code);
      expect(entry.readableName.length, `${code}.readableName too terse`).toBeGreaterThan(10);
      expect(entry.description.length, `${code}.description too terse`).toBeGreaterThan(20);
      expect(entry.cause.length, `${code}.cause too terse`).toBeGreaterThan(20);
      expect(entry.stepsToFix.length, `${code} needs at least one step to fix`).toBeGreaterThan(0);
      for (const step of entry.stepsToFix) expect(step.length).toBeGreaterThan(5);
    }
  });

  it('documents every code the app actually raises', () => {
    // A toastError('X') with no catalogue entry degrades to showing the bare
    // code to the user — catch that here rather than in the wild.
    const files = sourceFiles(SRC);
    const raised = new Set<string>();
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/toastError\(\s*'([A-Z0-9_]+)'\s*\)/g)) raised.add(m[1]!);
    }

    expect(raised.size, 'expected at least one catalogued error to be raised').toBeGreaterThan(0);
    for (const code of raised) {
      expect(errorEntry(code), `${code} is raised in src/ but missing from catalog.json`).toBeDefined();
    }
  });

  it('falls back to the bare code rather than throwing on an unknown one', () => {
    expect(errorEntry('NO_SUCH_CODE')).toBeUndefined();
    expect(errorMessage('NO_SUCH_CODE')).toBe('NO_SUCH_CODE');
  });

  it('describes the fail-closed voice error', () => {
    const e = errorEntry('VOICE_E2EE_UNSUPPORTED');
    expect(e).toBeDefined();
    // The cause must explain the tradeoff, since refusing the call is a
    // deliberate choice the user did not make.
    expect(e!.cause.toLowerCase()).toContain('encrypt');
  });
});
