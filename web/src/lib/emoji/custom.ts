import { reactive } from 'vue';
import type { AttachmentRef } from '@notes/shared';
import { useSessionStore } from '../../stores/session';
import { api } from '../api';
import { decryptBlob, unwrapKey, wrapKey } from '../crypto';
import { encryptAndUploadFile } from '../attachments';
import { clearCustomEmoji, registerCustomEmoji } from './index';

// Per-user custom emoji. Each image is an encrypted attachment (a fresh per-file
// key, like note/chat attachments); the palette (name -> ref) is itself stored
// as a master-key-encrypted settings blob, so the server never sees the names
// or images. When a custom emoji is used in a message, its ref is embedded in
// the encrypted payload (MessagePayload.customEmoji) so recipients — who don't
// have the sender's palette — can decrypt + render it.

export interface CustomEmoji {
  name: string;
  ref: AttachmentRef;
}

const SETTING_KEY = 'chat-emoji';
const INFO = 'notes:wrap:settings:v1';
const NAME_RE = /^[A-Za-z0-9_]{2,40}$/;

export const customEmoji = reactive<{ items: CustomEmoji[] }>({ items: [] });

// Decrypted object URLs, cached by attachment id (shared by the picker, the
// owner's palette, and embedded emoji received from others).
const urlCache = new Map<string, string>();

async function decryptToUrl(ref: AttachmentRef): Promise<string | null> {
  const cached = urlCache.get(ref.id);
  if (cached) return cached;
  try {
    const ct = await api.attachmentDownload(ref.id);
    const data = await decryptBlob(ct, ref.key, ref.iv);
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: ref.type }));
    urlCache.set(ref.id, url);
    return url;
  } catch {
    return null;
  }
}

async function persist(): Promise<void> {
  const session = useSessionStore();
  if (!session.mk) return;
  const wrapped = await wrapKey(session.mk, new TextEncoder().encode(JSON.stringify(customEmoji.items)), INFO);
  await api.settingPut(SETTING_KEY, JSON.stringify(wrapped)).catch(() => {});
}

let loaded = false;

/** Fetch + decrypt the palette and register each emoji for rendering. */
export async function loadCustomEmoji(): Promise<void> {
  const session = useSessionStore();
  if (loaded || !session.mk) return;
  loaded = true;
  try {
    const remote = await api.settingGet(SETTING_KEY);
    if (!remote) return;
    const pt = await unwrapKey(session.mk, JSON.parse(remote.data), INFO);
    customEmoji.items = JSON.parse(new TextDecoder().decode(pt)) as CustomEmoji[];
    for (const e of customEmoji.items) {
      const url = await decryptToUrl(e.ref);
      if (url) registerCustomEmoji(e.name, url);
    }
  } catch {
    loaded = false; // network/decrypt hiccup: retry next call
  }
}

export async function addCustomEmoji(name: string, file: File): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error('Name must be 2–40 letters, digits or underscores.');
  if (customEmoji.items.some((e) => e.name === name)) throw new Error('That name is already used.');
  const ref = await encryptAndUploadFile(file);
  customEmoji.items = [...customEmoji.items, { name, ref }];
  // Register from the local file directly — no need to round-trip the blob we
  // just uploaded.
  const url = URL.createObjectURL(file);
  urlCache.set(ref.id, url);
  registerCustomEmoji(name, url);
  await persist();
}

export async function removeCustomEmoji(name: string): Promise<void> {
  customEmoji.items = customEmoji.items.filter((e) => e.name !== name);
  await persist();
  // The encrypted blob is left in place (harmless ciphertext); the palette no
  // longer references it.
}

/** The emoji refs to embed for the `:shortcodes:` actually used in `text`. */
export function customEmojiForText(text: string): Record<string, AttachmentRef> | undefined {
  const out: Record<string, AttachmentRef> = {};
  const re = /:([A-Za-z0-9_]{2,40}):/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const e = customEmoji.items.find((x) => x.name === m![1]);
    if (e) out[e.name] = e.ref;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Register custom emoji embedded in a received message so they render. Awaited
 *  before the message view is shown, so the first render already resolves them. */
export async function registerEmbeddedEmoji(map: Record<string, AttachmentRef>): Promise<void> {
  for (const [name, ref] of Object.entries(map)) {
    const url = await decryptToUrl(ref);
    if (url) registerCustomEmoji(name, url);
  }
}

/** Clear palette + revoke object URLs (on lock/logout). */
export function resetCustomEmoji(): void {
  loaded = false;
  customEmoji.items = [];
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
  clearCustomEmoji();
}
