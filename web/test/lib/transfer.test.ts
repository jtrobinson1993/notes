// @vitest-environment node
// transfer.ts is pure (fflate + string munging); run under Node so File/Blob
// have a working arrayBuffer() for the zip round-trip.
import { describe, expect, it } from 'vitest';
import {
  convertBody,
  exportNotesZip,
  parseImportFiles,
  toPlainText,
  type ExportFormat,
} from '../../src/lib/transfer';
import type { DecryptedNote } from '../../src/stores/notes';

function note(title: string, body: string, tags: string[] = []): DecryptedNote {
  return {
    payload: { title, body, tags },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
  } as DecryptedNote;
}

describe('convertBody formats', () => {
  it('as-is is the identity', () => {
    const body = 'a ==hl== ||sp|| <u>u</u> **b**';
    expect(convertBody(body, 'as-is')).toBe(body);
  });

  it('obsidian unwraps ||spoilers|| but keeps ==highlight== and <u>', () => {
    expect(convertBody('a ||secret|| b', 'obsidian')).toBe('a secret b');
    expect(convertBody('==hi== <u>u</u>', 'obsidian')).toBe('==hi== <u>u</u>');
  });

  it('standard strips <u>/<span>, unwraps == and ||', () => {
    expect(convertBody('<u>u</u> ==hi== ||sp||', 'standard')).toBe('u hi sp');
  });

  it('plain strips all markup', () => {
    const out = toPlainText('# Head\n\n**bold** _it_ `code` [link](http://x) ==hl==');
    expect(out).not.toMatch(/[#*`>]|http/);
    expect(out).toContain('bold');
    expect(out).toContain('link');
  });
});

describe('export → import round-trip', () => {
  async function roundTrip(notes: DecryptedNote[], format: ExportFormat) {
    const blob = exportNotesZip(notes, format);
    const file = new File([blob], 'export.zip', { type: 'application/zip' });
    return parseImportFiles([file] as unknown as FileList);
  }

  it('preserves title, tags, and body (as-is)', async () => {
    const imported = await roundTrip([note('My Note', 'Hello **world**', ['x', 'y'])], 'as-is');
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatchObject({ title: 'My Note', body: 'Hello **world**', tags: ['x', 'y'] });
  });

  it('disambiguates duplicate titles into separate files', async () => {
    const imported = await roundTrip([note('Same', 'one'), note('Same', 'two')], 'as-is');
    expect(imported).toHaveLength(2);
    expect(imported.map((n) => n.body).sort()).toEqual(['one', 'two']);
  });

  it('applies the export format to the body (standard unwraps ==)', async () => {
    const imported = await roundTrip([note('H', 'a ==hi== b')], 'standard');
    expect(imported[0]!.body).toBe('a hi b');
  });
});

describe('parseImportFiles', () => {
  it('reads a bare .md file, defaulting the title to the filename', async () => {
    const file = new File(['no frontmatter here'], 'Shopping List.md', { type: 'text/markdown' });
    const [n] = await parseImportFiles([file] as unknown as FileList);
    expect(n).toMatchObject({ title: 'Shopping List', body: 'no frontmatter here', tags: [] });
  });

  it('parses YAML-ish frontmatter for title and tags', async () => {
    const md = '---\ntitle: "Quarterly"\ntags: ["work","q3"]\n---\nThe body.';
    const file = new File([md], 'q.md');
    const [n] = await parseImportFiles([file] as unknown as FileList);
    expect(n).toMatchObject({ title: 'Quarterly', tags: ['work', 'q3'], body: 'The body.' });
  });
});
