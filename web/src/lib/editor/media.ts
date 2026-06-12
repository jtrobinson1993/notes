import { Facet } from '@codemirror/state';
import { WidgetType } from '@codemirror/view';

// Resolves an attachment id to a decrypted object URL (null = not found).
export type AttachmentResolver = (id: string) => Promise<string | null>;

export const attachmentResolver = Facet.define<AttachmentResolver, AttachmentResolver | null>({
  combine: (values) => values[0] ?? null,
});

export interface VideoEmbed {
  platform: 'youtube' | 'vimeo';
  id: string;
}

const YT_RE = /^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/)|youtu\.be\/)([\w-]{6,20})/;
const VIMEO_RE = /^https?:\/\/(?:www\.)?vimeo\.com\/(\d{4,12})/;

export function parseVideoUrl(url: string): VideoEmbed | null {
  const yt = YT_RE.exec(url);
  if (yt) return { platform: 'youtube', id: yt[1]! };
  const vm = VIMEO_RE.exec(url);
  if (vm) return { platform: 'vimeo', id: vm[1]! };
  return null;
}

export function embedSrc(embed: VideoEmbed): string {
  return embed.platform === 'youtube'
    ? `https://www.youtube-nocookie.com/embed/${embed.id}`
    : `https://player.vimeo.com/video/${embed.id}`;
}

const YT_LOGO =
  '<svg viewBox="0 0 28 20" width="28" height="20"><path fill="#f00" d="M27.4 3.1A3.5 3.5 0 0 0 25 .7C22.8 0 14 0 14 0S5.2 0 3 .7A3.5 3.5 0 0 0 .6 3.1 36.6 36.6 0 0 0 0 10c0 2.3.2 4.6.6 6.9A3.5 3.5 0 0 0 3 19.3c2.2.7 11 .7 11 .7s8.8 0 11-.7a3.5 3.5 0 0 0 2.4-2.4c.4-2.3.6-4.6.6-6.9 0-2.3-.2-4.6-.6-6.9z"/><path fill="#fff" d="M11.2 14.3 18.5 10l-7.3-4.3z"/></svg>';
const VIMEO_LOGO =
  '<svg viewBox="0 0 28 24" width="24" height="21"><path fill="#1ab7ea" d="M27.9 5.6c-.1 2.7-2 6.4-5.6 11.1-3.7 4.9-6.9 7.3-9.5 7.3-1.6 0-2.9-1.5-4-4.4L6.6 11.7C5.8 8.8 5 7.3 4.1 7.3c-.2 0-.9.4-2 1.2L.8 6.9 4.7 3.4C6.4 1.9 7.7 1.1 8.6 1c2.1-.2 3.3 1.2 3.8 4.2.5 3.3.9 5.3 1.1 6.1.6 2.8 1.3 4.2 2 4.2.6 0 1.5-.9 2.6-2.7 1.1-1.8 1.8-3.2 1.9-4.1.2-1.6-.5-2.3-1.9-2.3-.7 0-1.4.2-2.1.5C17.4 2.3 20.1.1 24.1.2c3 .1 4.3 1.9 3.8 5.4z"/></svg>';

// Click-to-load video embed: shows a neutral placeholder with the platform
// logo; no request leaves the client until the user clicks (protects reader
// IPs from Google/Vimeo per spec).
export class EmbedWidget extends WidgetType {
  constructor(readonly embed: VideoEmbed) {
    super();
  }

  override eq(other: EmbedWidget): boolean {
    return other.embed.platform === this.embed.platform && other.embed.id === this.embed.id;
  }

  toDOM(): HTMLElement {
    return buildEmbedPlaceholder(this.embed);
  }
}

export function buildEmbedPlaceholder(embed: VideoEmbed): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'embed-placeholder';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'embed-placeholder-btn';
  btn.innerHTML = `${embed.platform === 'youtube' ? YT_LOGO : VIMEO_LOGO}<span>Load ${
    embed.platform === 'youtube' ? 'YouTube' : 'Vimeo'
  } video</span>`;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const iframe = document.createElement('iframe');
    iframe.src = embedSrc(embed);
    iframe.className = 'embed-iframe';
    iframe.allow = 'accelerometer; encrypted-media; fullscreen; picture-in-picture';
    iframe.allowFullscreen = true;
    wrap.replaceChildren(iframe);
    wrap.classList.add('embed-loaded');
  });
  wrap.append(btn);
  return wrap;
}

// Inline image rendered in place of ![alt](src). attachment: sources are
// resolved to decrypted object URLs via the attachmentResolver facet; spoiler
// images stay blurred until clicked.
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly spoiler: boolean,
    readonly resolver: AttachmentResolver | null,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt && other.spoiler === this.spoiler;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-image-widget';
    const img = document.createElement('img');
    img.alt = this.alt;
    img.className = 'cm-image';
    if (this.src.startsWith('attachment:')) {
      const id = this.src.slice('attachment:'.length);
      if (this.resolver) {
        void this.resolver(id).then((url) => {
          if (url) img.src = url;
          else img.alt = `[missing attachment ${this.alt}]`;
        });
      }
    } else if (/^https?:/.test(this.src)) {
      img.src = this.src;
    }
    if (this.spoiler) {
      wrap.classList.add('spoiler-image');
      wrap.addEventListener('click', () => wrap.classList.toggle('spoiler-image-revealed'), true);
    }
    wrap.append(img);
    return wrap;
  }
}
