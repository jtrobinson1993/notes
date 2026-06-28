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

const AUDIO_EXT = /\.(mp3|m4a|aac|oga|ogg|opus|wav|flac|weba)$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov)$/i;

/**
 * Classify an attachment as inline-playable media from either its MIME type
 * (`audio/mpeg`, `video/mp4`) or its filename extension (`song.mp3`,
 * `clip.webm`) — returns `'audio'`, `'video'`, or `null` for anything else.
 * The actual element only plays if the blob's real MIME type is supported; this
 * just decides which player (if any) to render. `.ogg` is treated as audio
 * (use `.ogv` for Ogg video).
 */
export function mediaKind(typeOrName: string): 'audio' | 'video' | null {
  if (typeOrName.startsWith('audio/')) return 'audio';
  if (typeOrName.startsWith('video/')) return 'video';
  if (AUDIO_EXT.test(typeOrName)) return 'audio';
  if (VIDEO_EXT.test(typeOrName)) return 'video';
  return null;
}

/**
 * Rewrite a filename's extension to match `type`, dropping the original one —
 * e.g. re-encoding `DSCF3984.jpeg` to WebP should yield `DSCF3984.webp`, not a
 * `.jpeg` name that contradicts the actual format. Falls back to stripping the
 * extension when the type has no usable subtype.
 */
export function nameForType(name: string, type: string): string {
  const base = name.replace(/\.[^.]+$/, '');
  const ext = formatMime(type).toLowerCase();
  return ext ? `${base}.${ext}` : base;
}
