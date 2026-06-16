/** Display helpers for attachment metadata (size, format). Pure + tested. */

/** Human-readable byte size: `812 B`, `44 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Short, uppercase format label from a MIME type:
 * `image/jpeg` → `JPEG`, `image/svg+xml` → `SVG`, `image/x-icon` → `ICON`.
 * Falls back to the whole string when there's no `type/subtype` shape.
 */
export function formatMime(type: string): string {
  const sub = type.split('/')[1] || type;
  return (sub.split('+')[0] || sub).replace(/^x-/, '').toUpperCase();
}
