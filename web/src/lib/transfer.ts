import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { DecryptedNote } from '../stores/notes';

export interface ImportedNote {
  title: string;
  body: string;
  tags: string[];
}

function filenameFor(note: DecryptedNote, used: Set<string>): string {
  const base = (note.payload.title || 'untitled').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'untitled';
  let name = `${base}.md`;
  let i = 2;
  while (used.has(name)) name = `${base}-${i++}.md`;
  used.add(name);
  return name;
}

// "Export as" formats: as-is keeps the extended syntax; standard strips
// non-standard constructs (HTML tags removed keeping inner text, ==/||
// unwrapped); plain strips all markup.
export type ExportFormat = 'as-is' | 'standard' | 'plain';

function toStandardMarkdown(body: string): string {
  return body
    .replace(/<\/?(?:u|span)(?:\s[^<>]*)?>/gi, '')
    .replace(/==([^=\n]+(?:=[^=\n]+)*)==/g, '$1')
    .replace(/\|\|([^|\n]+(?:\|[^|\n]+)*)\|\|/g, '$1');
}

function toPlainText(body: string): string {
  return toStandardMarkdown(body)
    .replace(/^```[^\n]*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^ {0,3}([-*_]){3,}\s*$/gm, '')
    .replace(/<[^<>]+>/g, '');
}

export function convertBody(body: string, format: ExportFormat): string {
  if (format === 'standard') return toStandardMarkdown(body);
  if (format === 'plain') return toPlainText(body);
  return body;
}

export function exportNotesZip(notes: DecryptedNote[], format: ExportFormat = 'as-is'): Blob {
  const used = new Set<string>();
  const files: Record<string, Uint8Array> = {};
  for (const note of notes) {
    const fm = [
      '---',
      `title: ${JSON.stringify(note.payload.title)}`,
      `tags: ${JSON.stringify(note.payload.tags)}`,
      `created: ${new Date(note.createdAt).toISOString()}`,
      `updated: ${new Date(note.updatedAt).toISOString()}`,
      '---',
      '',
    ].join('\n');
    files[filenameFor(note, used)] = strToU8(fm + convertBody(note.payload.body, format));
  }
  return new Blob([zipSync(files) as BlobPart], { type: 'application/zip' });
}

function parseMarkdown(filename: string, text: string): ImportedNote {
  let title = filename.replace(/\.(md|txt|markdown)$/i, '').split('/').pop() ?? 'Imported';
  let tags: string[] = [];
  let body = text;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    for (const line of fm[1]!.split('\n')) {
      const m = /^(\w+):\s*(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === 'title') {
        try { title = JSON.parse(m[2]!) as string; } catch { title = m[2]!; }
      } else if (m[1] === 'tags') {
        try {
          const parsed: unknown = JSON.parse(m[2]!);
          if (Array.isArray(parsed)) tags = parsed.map(String);
        } catch { /* ignore malformed tags */ }
      }
    }
  }
  return { title, body, tags };
}

export async function parseImportFiles(files: FileList): Promise<ImportedNote[]> {
  const out: ImportedNote[] = [];
  for (const file of files) {
    if (file.name.toLowerCase().endsWith('.zip')) {
      const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
      for (const [name, data] of Object.entries(entries)) {
        if (/\.(md|txt|markdown)$/i.test(name)) out.push(parseMarkdown(name, strFromU8(data)));
      }
    } else {
      out.push(parseMarkdown(file.name, await file.text()));
    }
  }
  return out;
}
