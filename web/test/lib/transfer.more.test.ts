// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { convertBody, exportNotesZip, parseImportFiles } from '../../src/lib/transfer';
import type { DecryptedNote } from '../../src/stores/notes';

function note(title: string, body: string): DecryptedNote {
  return { payload: { title, body, tags: [] }, createdAt: 0, updatedAt: 0 } as DecryptedNote;
}

describe('export edge cases', () => {
  it('names the file "untitled.md" when the title is empty', async () => {
    const blob = exportNotesZip([note('', 'body')], 'as-is');
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(entries)).toContain('untitled.md');
  });

  it('convertBody routes the plain format through toPlainText', () => {
    expect(convertBody('# H\n**b**', 'plain')).not.toMatch(/[#*]/);
  });
});

describe('import edge cases', () => {
  it('tolerates malformed frontmatter (non-JSON title kept raw, bad tags ignored)', async () => {
    const md = '---\ntitle: Plain Title\ntags: not-an-array\n---\nbody';
    const file = new File([md], 'n.md');
    const [n] = await parseImportFiles([file] as unknown as FileList);
    expect(n).toMatchObject({ title: 'Plain Title', tags: [], body: 'body' });
  });

  it('skips non-markdown entries inside a zip', async () => {
    const zip = zipSync({
      'keep.md': strToU8('---\ntitle: "Keep"\n---\nhi'),
      'image.png': new Uint8Array([1, 2, 3]),
      'data.json': strToU8('{}'),
    });
    const file = new File([zip], 'archive.zip');
    const imported = await parseImportFiles([file] as unknown as FileList);
    expect(imported).toHaveLength(1);
    expect(imported[0]!.title).toBe('Keep');
  });
});
